import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
}

const DEFAULT_PATHS = ['pom.xml'];

export function parsePomDependencies(pomXml: string): MavenDependency[] {
  const deps: MavenDependency[] = [];
  const depBlockRegex = /<dependency>([\s\S]*?)<\/dependency>/g;

  let match: RegExpExecArray | null;
  while ((match = depBlockRegex.exec(pomXml)) !== null) {
    const block = match[1];

    const groupIdMatch = /<groupId>\s*(.*?)\s*<\/groupId>/.exec(block);
    const artifactIdMatch = /<artifactId>\s*(.*?)\s*<\/artifactId>/.exec(block);
    const versionMatch = /<version>\s*(.*?)\s*<\/version>/.exec(block);

    if (!groupIdMatch || !artifactIdMatch || !versionMatch) continue;

    const version = versionMatch[1];

    // Skip property references like ${project.version}
    if (version.startsWith('${')) continue;

    deps.push({
      groupId: groupIdMatch[1],
      artifactId: artifactIdMatch[1],
      version,
    });
  }

  return deps;
}

/**
 * Read every discovered pom.xml (root + reactor modules) and union their
 * declared dependencies. Deduped by `groupId:artifactId` with first-seen
 * (root-first) wins. Gradle manifests (build.gradle[.kts]) carry no
 * `<dependency>` blocks and so contribute nothing — there is no Gradle parser
 * yet, as before.
 *
 * Known limitation: dependencies whose version is managed by a parent pom's
 * `<dependencyManagement>` (child `<dependency>` blocks omitting `<version>`)
 * are skipped by the parser, so a reactor relying on managed versions yields
 * fewer deps than installed. Resolving inherited versions is tracked as a
 * follow-up.
 */
export async function collectJavaDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<MavenDependency[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  const byKey = new Map<string, MavenDependency>();
  for (const { content } of contents) {
    for (const dep of parsePomDependencies(content)) {
      const key = `${dep.groupId}:${dep.artifactId}`;
      if (!byKey.has(key)) byKey.set(key, dep);
    }
  }

  return [...byKey.values()];
}
