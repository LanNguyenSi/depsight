import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface ParsedPyDep {
  name: string;
  version: string;
}

// Conventional root manifests, used when no discovered paths are supplied so a
// direct/defensive call still behaves like the legacy single-root probe.
const DEFAULT_PATHS = ['pyproject.toml', 'requirements.txt'];

/**
 * Parse a pyproject.toml `dependencies` array using simple regex.
 * Handles formats like: "requests>=2.28", "flask==2.3.0", "numpy"
 */
export function parsePyprojectToml(content: string): ParsedPyDep[] {
  const deps: ParsedPyDep[] = [];

  // Find the [project] section's dependencies array
  const depsBlockMatch = /\bdependencies\s*=\s*\[([^\]]*)\]/s.exec(content);
  if (!depsBlockMatch) return deps;

  const block = depsBlockMatch[1];
  // Extract each quoted string from the array
  const entryPattern = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    const raw = match[1].trim();
    parseDependencySpec(raw, deps);
  }

  return deps;
}

/**
 * Parse requirements.txt lines.
 * Handles: package==1.0.0, package>=1.0.0, package~=1.0.0, package (no version)
 */
export function parseRequirementsTxt(content: string): ParsedPyDep[] {
  const deps: ParsedPyDep[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // Skip comments, empty lines, and options
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    parseDependencySpec(line, deps);
  }

  return deps;
}

/**
 * Parse a single dependency specifier like "requests>=2.28" into name + version.
 * Strips comparison operators to extract the package name and pinned/minimum version.
 */
function parseDependencySpec(spec: string, deps: ParsedPyDep[]): void {
  // Remove extras like [security] and environment markers like ; python_version >= "3.8"
  const withoutMarkers = spec.split(';')[0].trim();
  const withoutExtras = withoutMarkers.replace(/\[.*?\]/, '');

  // Split on version operators: ==, >=, <=, ~=, !=, >, <
  const splitMatch = /^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+)\s*(.+)$/.exec(withoutExtras);
  if (splitMatch) {
    const name = splitMatch[1].trim();
    // Take only the first version if there are multiple constraints (e.g. ">=1.0,<2.0")
    const versionPart = splitMatch[2].split(',')[0].trim();
    deps.push({ name, version: versionPart });
  } else {
    // No version specifier
    const name = withoutExtras.trim();
    if (name) {
      deps.push({ name, version: '' });
    }
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

interface DirManifests {
  pyproject?: string;
  requirements?: string;
}

/**
 * Read every discovered Python manifest (root + monorepo modules) and union
 * their dependencies. Modules are unioned, but WITHIN a single directory
 * pyproject.toml takes precedence over requirements.txt (with a fallback to
 * requirements.txt when pyproject declares no PEP 621 `dependencies` array).
 * This mirrors the legacy single-manifest precedence: a module that ships both
 * a pyproject.toml and a pip-freeze-style requirements.txt is not double-counted
 * with the full transitive tree. Other Python manifest types (setup.py, Pipfile)
 * have no parser and are skipped, as before. Deduped by package name with
 * first-seen (root-first) wins.
 *
 * Version collapse: if two modules pin the same package at different versions,
 * the first-seen spec is kept and the others dropped. Per-module version
 * provenance is a deliberate follow-up (see manifest-discovery `unionNpmDeps`).
 */
export async function collectPythonDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<ParsedPyDep[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  // Group manifests by directory, remembering each directory's first
  // appearance so the union stays root-first.
  const byDir = new Map<string, DirManifests>();
  const dirOrder: string[] = [];
  for (const { path, content } of contents) {
    const base = path.split('/').pop()?.toLowerCase() ?? '';
    if (base !== 'pyproject.toml' && base !== 'requirements.txt') continue; // setup.py / Pipfile: no parser

    const dir = dirOf(path);
    let entry = byDir.get(dir);
    if (!entry) {
      entry = {};
      byDir.set(dir, entry);
      dirOrder.push(dir);
    }
    if (base === 'pyproject.toml') {
      if (entry.pyproject === undefined) entry.pyproject = content;
    } else if (entry.requirements === undefined) {
      entry.requirements = content;
    }
  }

  const byName = new Map<string, ParsedPyDep>();
  for (const dir of dirOrder) {
    const { pyproject, requirements } = byDir.get(dir)!;
    let parsed = pyproject !== undefined ? parsePyprojectToml(pyproject) : [];
    // Fall back to requirements.txt only when pyproject is absent or declares
    // no dependencies (legacy precedence, applied per directory).
    if (parsed.length === 0 && requirements !== undefined) {
      parsed = parseRequirementsTxt(requirements);
    }
    for (const dep of parsed) {
      if (!byName.has(dep.name)) byName.set(dep.name, dep);
    }
  }

  return [...byName.values()];
}
