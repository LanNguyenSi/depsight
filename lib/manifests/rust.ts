import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface CargoDep {
  name: string;
  version: string;
  /**
   * Member dependency declared as `{ workspace = true }`. Its version is
   * resolved from the workspace's `[workspace.dependencies]` table during
   * collection; carries an empty version until then.
   */
  inheritsWorkspace?: boolean;
}

const DEFAULT_PATHS = ['Cargo.toml'];

/**
 * Parse a single dependency line into name + version, or null if it is not a
 * versioned dependency. Handles:
 *   serde = "1.0"
 *   serde = { version = "1.0", features = [...] }
 */
function parseDepLine(line: string): CargoDep | null {
  // name = "version"
  const simpleMatch = /^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
  if (simpleMatch) return { name: simpleMatch[1], version: simpleMatch[2] };

  // name = { version = "version", ... }
  const tableMatch = /^([a-zA-Z0-9_-]+)\s*=\s*\{.*?version\s*=\s*"([^"]*)"/.exec(line);
  if (tableMatch) return { name: tableMatch[1], version: tableMatch[2] };

  return null;
}

/**
 * Detect a workspace-inherited dependency line, e.g.
 *   serde = { workspace = true }
 *   serde = { workspace = true, features = ["derive"] }
 *   serde.workspace = true            (dotted-key form)
 * Returns the crate name, or null if the line is not a workspace inherit.
 */
function workspaceInheritName(line: string): string | null {
  // Inline-table form: name = { workspace = true, ... }
  const inline = /^([a-zA-Z0-9_-]+)\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b/.exec(line);
  if (inline) return inline[1];

  // Dotted-key form: name.workspace = true
  const dotted = /^([a-zA-Z0-9_-]+)\.workspace\s*=\s*true\b/.exec(line);
  if (dotted) return dotted[1];

  return null;
}

/**
 * Parse a Cargo.toml file to extract dependencies from `[dependencies]` and
 * `[dev-dependencies]`. Inline-versioned deps carry their version; deps
 * declared as `{ workspace = true }` are returned with `inheritsWorkspace`
 * set and an empty version, to be resolved against the workspace table.
 */
export function parseCargoToml(content: string): CargoDep[] {
  const deps: CargoDep[] = [];
  let inDepsSection = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Detect section headers
    if (line.startsWith('[')) {
      inDepsSection =
        line === '[dependencies]' ||
        line === '[dev-dependencies]';
      continue;
    }

    if (!inDepsSection || !line || line.startsWith('#')) continue;

    const dep = parseDepLine(line);
    if (dep) {
      deps.push(dep);
      continue;
    }

    const inheritName = workspaceInheritName(line);
    if (inheritName) {
      deps.push({ name: inheritName, version: '', inheritsWorkspace: true });
    }
  }

  return deps;
}

/**
 * Parse the `[workspace.dependencies]` table — the version source of truth for
 * crates that members inherit via `{ workspace = true }`. Same line grammar as
 * a normal dependency section.
 */
export function parseCargoWorkspaceDeps(content: string): CargoDep[] {
  const deps: CargoDep[] = [];
  let inSection = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith('[')) {
      inSection = line === '[workspace.dependencies]';
      continue;
    }

    if (!inSection || !line || line.startsWith('#')) continue;

    const dep = parseDepLine(line);
    if (dep) deps.push(dep);
  }

  return deps;
}

/**
 * Read every discovered Cargo.toml (workspace root + member crates) and union
 * their dependencies. Deduped by crate name with first-seen (root-first) wins.
 * A virtual workspace root (only `[workspace]`, no `[dependencies]`) contributes
 * nothing of its own. Pure path-only `{ path = "../x" }` member deps carry no
 * version and are skipped by the parser.
 *
 * Workspace dependency inheritance is resolved: versions declared once in a
 * `[workspace.dependencies]` table are applied to member crates that opt in via
 * `serde = { workspace = true }`. An inherited dep whose name is absent from the
 * workspace table keeps an empty version (surfaced as UNKNOWN downstream) rather
 * than being dropped. Resolution only spans the discovered manifests; it does
 * not chase a workspace root outside the repo.
 */
export async function collectRustDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<CargoDep[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  // Pass 1: collect the workspace dependency versions (the table is usually in
  // the workspace root, but is gathered from every manifest defensively).
  const workspaceVersions = new Map<string, string>();
  for (const { content } of contents) {
    for (const dep of parseCargoWorkspaceDeps(content)) {
      if (!workspaceVersions.has(dep.name)) workspaceVersions.set(dep.name, dep.version);
    }
  }

  // Pass 2: union member deps, resolving workspace-inherited versions.
  const byName = new Map<string, CargoDep>();
  for (const { content } of contents) {
    for (const dep of parseCargoToml(content)) {
      const version = dep.inheritsWorkspace
        ? (workspaceVersions.get(dep.name) ?? '')
        : dep.version;
      if (!byName.has(dep.name)) byName.set(dep.name, { name: dep.name, version });
    }
  }

  return [...byName.values()];
}
