import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';
import { parseGradleDependencies } from '@/lib/manifests/gradle';

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
}

interface RawMavenDep {
  groupId: string;
  artifactId: string;
  // null when the <dependency> omits <version> or uses a ${...} property
  // reference (which we cannot resolve from the manifest alone).
  version: string | null;
}

const DEFAULT_PATHS = ['pom.xml', 'build.gradle', 'build.gradle.kts'];

function isGradlePath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return base === 'build.gradle' || base === 'build.gradle.kts';
}

/**
 * Parse every `<dependency>` block in the given XML fragment into coordinates +
 * an optional version. A version that is absent or a `${...}` property
 * reference is returned as null (unresolved). Used for both the regular
 * `<dependencies>` and the `<dependencyManagement>` section.
 */
function parseDependencyBlocks(xml: string): RawMavenDep[] {
  const deps: RawMavenDep[] = [];
  const depBlockRegex = /<dependency>([\s\S]*?)<\/dependency>/g;

  let match: RegExpExecArray | null;
  while ((match = depBlockRegex.exec(xml)) !== null) {
    const block = match[1];

    const groupIdMatch = /<groupId>\s*(.*?)\s*<\/groupId>/.exec(block);
    const artifactIdMatch = /<artifactId>\s*(.*?)\s*<\/artifactId>/.exec(block);
    if (!groupIdMatch || !artifactIdMatch) continue;

    const versionMatch = /<version>\s*(.*?)\s*<\/version>/.exec(block);
    // Skip property references like ${project.version} — treat as unresolved.
    const version = versionMatch && !versionMatch[1].startsWith('${') ? versionMatch[1] : null;

    deps.push({ groupId: groupIdMatch[1], artifactId: artifactIdMatch[1], version });
  }

  return deps;
}

/**
 * Build a `groupId:artifactId -> version` map from every `<dependencyManagement>`
 * section in a pom. These are the versions a parent pom manages on behalf of its
 * reactor children, which omit `<version>` in their own `<dependency>` blocks.
 */
function parseDependencyManagement(pomXml: string): Map<string, string> {
  const managed = new Map<string, string>();
  const dmRegex = /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/g;

  let dm: RegExpExecArray | null;
  while ((dm = dmRegex.exec(pomXml)) !== null) {
    for (const dep of parseDependencyBlocks(dm[1])) {
      if (dep.version === null) continue;
      const key = `${dep.groupId}:${dep.artifactId}`;
      if (!managed.has(key)) managed.set(key, dep.version);
    }
  }

  return managed;
}

/**
 * Remove the `<dependencyManagement>` sections so their entries are read only as
 * a version source, not counted as actual dependencies (they are declarations,
 * and would otherwise surface BOM imports and managed-but-unused artifacts as
 * installed deps).
 */
function stripDependencyManagement(pomXml: string): string {
  return pomXml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
}

/**
 * Read every discovered pom.xml and Gradle build file (root + modules) and
 * union their declared dependencies. Deduped by `groupId:artifactId` with
 * first-seen (root-first) wins. Gradle build files (build.gradle,
 * build.gradle.kts) are read with the parser in lib/manifests/gradle.ts: only
 * literal versions count, and they take part in the same first-seen dedupe as
 * the poms, in path order.
 *
 * Versions managed by a parent pom's `<dependencyManagement>` are resolved: the
 * managed versions are aggregated across all discovered poms, then versionless
 * child `<dependency>` blocks are resolved against that map. `<dependencyManagement>`
 * entries are used only as a version source, not counted as dependencies
 * themselves. A `${...}` property reference is never resolved; a versionless dep
 * with no managed version is skipped, as before.
 */
export async function collectJavaDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<MavenDependency[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  // Pass 1: aggregate dependencyManagement versions across the whole reactor.
  const managed = new Map<string, string>();
  for (const { path, content } of contents) {
    if (isGradlePath(path)) continue;
    for (const [key, version] of parseDependencyManagement(content)) {
      if (!managed.has(key)) managed.set(key, version);
    }
  }

  // Pass 2: union the actual <dependencies> (dependencyManagement stripped out),
  // resolving versionless ones from the managed map.
  const byKey = new Map<string, MavenDependency>();
  for (const { path, content } of contents) {
    const raws = isGradlePath(path)
      ? parseGradleDependencies(content)
      : parseDependencyBlocks(stripDependencyManagement(content));
    for (const raw of raws) {
      const key = `${raw.groupId}:${raw.artifactId}`;
      const version = raw.version ?? managed.get(key) ?? null;
      if (version === null) continue; // unresolved versionless — skip, as before
      if (!byKey.has(key)) {
        byKey.set(key, { groupId: raw.groupId, artifactId: raw.artifactId, version });
      }
    }
  }

  return [...byKey.values()];
}
