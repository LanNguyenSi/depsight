import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface ParsedPyDep {
  name: string;
  version: string;
}

// ---- Python name normalization (PEP 503) ------------------------------------

/**
 * Normalize a Python package name to its PEP 503 canonical form: lowercase with
 * runs of `_`, `.`, or `-` collapsed to a single `-`. Applied when building and
 * looking up lockfile resolution keys so that `my_package` and `my-package`
 * resolve to the same entry.
 *
 * Pure function — exported for testing.
 */
export function normalizePythonPackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

// ---- Python lockfile version comparison -------------------------------------

// Simple numeric version comparison. Lockfile versions are exact (no range
// operators), so a triple-integer comparison is correct.
function pyVersionIsLower(a: string, b: string): boolean {
  const parse = (s: string): [number, number, number] => {
    const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return [0, 0, 0];
    return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

// ---- Python lockfile resolver -----------------------------------------------

/**
 * Discover the `uv.lock` and `poetry.lock` paths that should be fetched for a
 * given set of Python manifest paths. Always probes the repo-root lockfiles;
 * also probes co-located lockfiles next to each discovered manifest.
 *
 * Pure function — exported for testing.
 */
export function discoverPythonLockfilePaths(manifestPaths: string[]): string[] {
  const lockPathSet = new Set<string>();
  // Always probe repo root
  lockPathSet.add('uv.lock');
  lockPathSet.add('poetry.lock');
  for (const p of manifestPaths) {
    const dir = p.split('/').slice(0, -1).join('/');
    if (dir) {
      // Co-located lockfiles for non-root manifests
      lockPathSet.add(`${dir}/uv.lock`);
      lockPathSet.add(`${dir}/poetry.lock`);
    }
    // dir === '' means the manifest is at the root — already probed above
  }
  return [...lockPathSet];
}

/**
 * Parse a list of `uv.lock` or `poetry.lock` content strings (both share the
 * same `[[package]]` TOML block structure) and return a flat
 * `normalizedPackageName → resolvedVersion` map.
 *
 * Each `[[package]]` block must contain both `name = "..."` and
 * `version = "..."` fields to be included; partial or malformed blocks are
 * silently skipped. Names are stored in PEP 503 canonical form (see
 * `normalizePythonPackageName`) so `my_package` and `my-package` resolve to
 * the same entry.
 *
 * For a package that appears in multiple entries (e.g. across two lockfiles),
 * the LOWEST resolved version is kept — security-conservative, mirroring the
 * npm `lockfileVersionIsLower` policy.
 *
 * Pure function — exported for testing.
 */
export function parsePythonLockfileContents(contentsList: string[]): Map<string, string> {
  const resolved = new Map<string, string>();

  const updateIfLower = (name: string, version: string): void => {
    if (!/\d/.test(version)) return; // skip non-concrete placeholders
    const normalized = normalizePythonPackageName(name);
    const existing = resolved.get(normalized);
    if (!existing || pyVersionIsLower(version, existing)) {
      resolved.set(normalized, version);
    }
  };

  for (const content of contentsList) {
    const lines = content.split('\n');
    let inBlock = false;
    let blockName: string | null = null;
    let blockVersion: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (line === '[[package]]') {
        // Commit the previous block if it has both required fields
        if (inBlock && blockName !== null && blockVersion !== null) {
          updateIfLower(blockName, blockVersion);
        }
        // Start a new block
        inBlock = true;
        blockName = null;
        blockVersion = null;
        continue;
      }

      if (!inBlock) continue;

      // First-match-wins within a block. The main [[package]] table always lists
      // `name` and `version` BEFORE any sub-table ([package.dependencies],
      // [package.source], [metadata], ...). poetry.lock sub-tables can contain a
      // constraint keyed literally `name` or `version` (e.g. a transitive dep
      // `version = ">=2.0"`); a last-match-wins parse would overwrite the block
      // with that garbage and silently hide the package's real vulns. uv.lock
      // inline-table arrays (`{ name = "x" }`) are already protected by the `^`
      // anchor (they start with `{`).
      const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (nameMatch) {
        if (blockName === null) blockName = nameMatch[1];
        continue;
      }

      const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(line);
      if (versionMatch) {
        if (blockVersion === null) blockVersion = versionMatch[1];
      }
    }

    // Commit the final block in this content string
    if (inBlock && blockName !== null && blockVersion !== null) {
      updateIfLower(blockName, blockVersion);
    }
  }

  return resolved;
}

/**
 * Given a list of Python manifest paths, discover and fetch the co-located
 * `uv.lock` / `poetry.lock` files plus the repo root lockfiles. Parse them and
 * return a flat `normalizedPackageName → resolvedVersion` map.
 *
 * Missing or unreadable lockfiles are silently skipped (404-safe). Returns an
 * empty map when no lockfiles are found; the caller must fall back to the
 * manifest-floor behaviour in that case.
 */
export async function fetchPythonLockfileResolutions(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[],
): Promise<Map<string, string>> {
  const lockPaths = discoverPythonLockfilePaths(manifestPaths);
  const fetched = await fetchManifestContents(octokit, owner, repo, lockPaths);
  if (fetched.length === 0) return new Map<string, string>();
  return parsePythonLockfileContents(fetched.map((f) => f.content));
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
