import semver from 'semver';
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

const CRATES_IO_SOURCES = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);

/**
 * Candidate Cargo.lock paths for a set of Cargo.toml paths: the repo root plus
 * every ancestor directory and the directory of each manifest. Cargo keeps one
 * lockfile at the workspace root, so a member crate's Cargo.toml in a
 * subdirectory resolves against the root (or an enclosing workspace) lock.
 * Probed paths may not exist; the fetch skips the missing ones.
 *
 * Pure function, exported for testing.
 */
export function discoverCargoLockPaths(manifestPaths: string[]): string[] {
  const lockPaths = new Set<string>(['Cargo.lock']);
  for (const p of manifestPaths) {
    const parts = p.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      lockPaths.add(`${parts.slice(0, i).join('/')}/Cargo.lock`);
    }
  }
  return [...lockPaths];
}

/**
 * Parse a Cargo.lock into the exact crates.io versions it resolves. Each
 * `[[package]]` table carries `name`, `version` and, for anything not local,
 * `source`. Entries are skipped, never guessed, when they cannot be looked up
 * on crates.io:
 *   - no `source` (the workspace's own member crates and `path` dependencies)
 *   - `git+...` sources
 *   - alternate registries (`registry+`/`sparse+` URLs other than crates.io)
 * A crate locked at several versions yields one entry per version.
 */
export function parseCargoLock(content: string): CargoDep[] {
  const deps: CargoDep[] = [];
  let inPackage = false;
  let name: string | null = null;
  let version: string | null = null;
  let source: string | null = null;

  const flush = () => {
    if (inPackage && name && version && source && CRATES_IO_SOURCES.has(source)) {
      deps.push({ name, version });
    }
    name = version = source = null;
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      flush();
      inPackage = line === '[[package]]';
      continue;
    }
    if (!inPackage || !line || line.startsWith('#')) continue;
    const kv = /^(name|version|source)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'name') name = kv[2];
    else if (kv[1] === 'version') version = kv[2];
    else source = kv[2];
  }
  flush();

  return deps;
}

/** A plain numeric requirement such as `1`, `1.2`, `1.2.3` or `1.2.3-rc.1`. */
const PLAIN_VERSION = /^\d+(\.\d+){0,2}(-[\w.]+)?(\+[\w.]+)?$/;

/**
 * Pick the locked version that resolves a Cargo.toml requirement. Cargo reads a
 * bare `1.2` as `^1.2` and joins comparators with commas, which npm-style
 * semver ranges spell differently, so the requirement is translated first:
 * plain numeric comparators get a caret, while operators (`=`, `~`, `>=`, ...)
 * and wildcards (`1.2.*`) pass through unchanged. When several locked versions
 * satisfy it the highest wins. An empty requirement or `*` matches every
 * (non-prerelease) locked version, so the highest one is returned. When the
 * requirement cannot be parsed the highest valid locked version is used. When
 * none satisfies it (or nothing is locked) null is returned and the caller
 * keeps the requirement.
 */
export function pickLockedVersion(requirement: string, locked: string[]): string | null {
  if (locked.length === 0) return null;
  const cargoReq = requirement
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (PLAIN_VERSION.test(c) ? `^${c}` : c))
    .join(' ');
  const range = cargoReq && cargoReq !== '*' ? semver.validRange(cargoReq) : '*';
  if (range === null) {
    return semver.rsort(locked.filter((v) => semver.valid(v) !== null))[0] ?? null;
  }
  return semver.maxSatisfying(locked, range);
}

export interface CargoWorkspace {
  members: string[];
  exclude: string[];
}

/**
 * Caps on the `members` and `exclude` patterns of a Cargo.toml `[workspace]`
 * table, mirroring the npm workspace matcher (`MAX_WORKSPACE_PATTERNS` and
 * `MAX_WORKSPACE_PATTERN_CHARS` in `lib/manifest-discovery.ts`). A `[workspace]`
 * whose `members` or `exclude` holds more than `MAX_CARGO_WORKSPACE_PATTERNS`
 * entries, or any entry longer than `MAX_CARGO_WORKSPACE_PATTERN_CHARS`
 * characters, is treated as not modelled: `parseCargoWorkspace` warns once
 * (naming the manifest path and which cap was hit, never the pattern text) and
 * returns null, so `nearestCargoLock` falls back to the nearest-lock walk
 * instead of compiling and matching an unbounded pattern list for every manifest
 * in the scan. Real Cargo workspaces list a handful of short globs, so the caps
 * only bite a hostile `Cargo.toml`.
 */
export const MAX_CARGO_WORKSPACE_PATTERNS = 1000;
export const MAX_CARGO_WORKSPACE_PATTERN_CHARS = 1024;

/**
 * Read the `members` and `exclude` arrays of a Cargo.toml `[workspace]` table.
 * Returns null when the file has no `[workspace]` table, and null for a
 * `[workspace]` that exceeds a cap (`MAX_CARGO_WORKSPACE_PATTERNS` entries per
 * key, or `MAX_CARGO_WORKSPACE_PATTERN_CHARS` characters per entry): that case
 * logs one `console.warn` naming `manifestPath` and the cap hit (never the
 * pattern text), so the caller drops it and `nearestCargoLock` falls back to the
 * nearest-lock walk rather than resolving an unbounded pattern set. Arrays may
 * span lines and carry `#` comments; only quoted string entries are read.
 *
 * Only the exact header `[workspace]` is recognised (not `[ workspace ]`).
 *
 * Exported for testing. Aside from the over-cap warning it is a pure read of
 * `content`.
 */
export function parseCargoWorkspace(content: string, manifestPath?: string): CargoWorkspace | null {
  let inWorkspace = false;
  let found = false;
  let key: 'members' | 'exclude' | null = null;
  const ws: CargoWorkspace = { members: [], exclude: [] };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!key && line.startsWith('[')) {
      inWorkspace = line === '[workspace]';
      if (inWorkspace) found = true;
      continue;
    }
    if (!inWorkspace) continue;
    let rest = line;
    if (!key) {
      const start = /^(members|exclude)\s*=\s*\[(.*)$/.exec(line);
      if (!start) continue;
      key = start[1] as 'members' | 'exclude';
      rest = start[2];
    }
    const closed = rest.includes(']');
    const body = closed ? rest.slice(0, rest.indexOf(']')) : rest;
    for (const m of body.matchAll(/"([^"]*)"|'([^']*)'/g)) ws[key].push(m[1] ?? m[2]);
    if (closed) key = null;
  }
  if (!found) return null;
  const over = overWorkspaceCap(ws);
  if (over !== null) {
    console.warn(
      `[depsight] Cargo workspace in ${manifestPath ?? '(unknown path)'} has ${over}; ` +
        `not modelled, falling back to the nearest Cargo.lock`,
    );
    return null;
  }
  return ws;
}

/**
 * Which `parseCargoWorkspace` cap `ws` exceeds, as a phrase to name in the
 * warning (no pattern text), or null when it fits within all caps.
 */
function overWorkspaceCap(ws: CargoWorkspace): string | null {
  if (ws.members.length > MAX_CARGO_WORKSPACE_PATTERNS) {
    return `more than ${MAX_CARGO_WORKSPACE_PATTERNS} members patterns`;
  }
  if (ws.exclude.length > MAX_CARGO_WORKSPACE_PATTERNS) {
    return `more than ${MAX_CARGO_WORKSPACE_PATTERNS} exclude patterns`;
  }
  if (ws.members.some((p) => p.length > MAX_CARGO_WORKSPACE_PATTERN_CHARS)) {
    return `a members pattern longer than ${MAX_CARGO_WORKSPACE_PATTERN_CHARS} characters`;
  }
  if (ws.exclude.some((p) => p.length > MAX_CARGO_WORKSPACE_PATTERN_CHARS)) {
    return `an exclude pattern longer than ${MAX_CARGO_WORKSPACE_PATTERN_CHARS} characters`;
  }
  return null;
}

/**
 * Member-glob RegExps built by `globToRegExp`. Exported so a test can show the
 * compile-once property (each pattern compiles at most once per workspace
 * object); production logic never reads it.
 */
export const cargoWorkspaceRegExpCompiles = { count: 0 };

function normalizeGlob(pattern: string): string {
  return pattern.replace(/^\.\//, '').replace(/\/+$/, '');
}

function globToRegExp(pattern: string): RegExp {
  const escaped = normalizeGlob(pattern)
    .split('/')
    .map((seg) =>
      seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'),
    )
    .join('/');
  cargoWorkspaceRegExpCompiles.count++;
  return new RegExp(`^${escaped}$`);
}

// The compiled `members` globs of a workspace, built at most once per workspace
// object and reused by every `isWorkspaceMember` call for it (`RegExp` has no
// `g`/`y` flag here, so a shared instance stays stateless across `.test`). A
// WeakMap keeps it off the returned object (so it stays `{ members, exclude }`)
// and drops the cache with the workspace.
const memberGlobsCache = new WeakMap<CargoWorkspace, RegExp[]>();

function compiledMemberGlobs(ws: CargoWorkspace): RegExp[] {
  let globs = memberGlobsCache.get(ws);
  if (globs === undefined) {
    globs = ws.members.map((p) => globToRegExp(p));
    memberGlobsCache.set(ws, globs);
  }
  return globs;
}

/**
 * Whether `memberDir` (relative to the workspace root) is a workspace member,
 * following Cargo: it matches an entry of `members`, and is not excluded. An
 * `exclude` entry is a path prefix, not a glob (`crates` excludes everything
 * under `crates/`), and a non-glob `members` entry that names the directory
 * exactly wins over `exclude`. Supported glob subset in `members`: `*` and `?`
 * inside one path segment (for example `crates/*`), plus exact paths; a
 * leading `./` and a trailing `/` are ignored.
 *
 * The `members` globs are compiled once per workspace object and reused across
 * calls, so a workspace read from `parseCargoWorkspace` builds at most
 * `MAX_CARGO_WORKSPACE_PATTERNS` RegExps in total no matter how many manifests
 * resolve against it. `parseCargoWorkspace` enforces those caps and the
 * `MAX_CARGO_WORKSPACE_PATTERN_CHARS` per-pattern length, dropping an over-cap
 * `[workspace]` (with a warning) so `nearestCargoLock` never sees one and falls
 * back to the nearest-lock walk.
 *
 * Not modelled: a `[ workspace ]` header with inner spaces, `package.workspace`
 * pointers, Cargo's implicit membership of path dependencies, `**` as a whole
 * segment (it behaves like `*`), character classes, and a non-glob `members`
 * entry naming a parent directory overriding `exclude` (Cargo allows that).
 */
export function isWorkspaceMember(ws: CargoWorkspace, memberDir: string): boolean {
  if (!compiledMemberGlobs(ws).some((glob) => glob.test(memberDir))) return false;
  if (ws.members.some((p) => !/[*?[]/.test(p) && normalizeGlob(p) === memberDir)) return true;
  return !ws.exclude.some((e) => {
    const ex = normalizeGlob(e);
    return memberDir === ex || memberDir.startsWith(`${ex}/`);
  });
}

/**
 * The Cargo.lock that governs a manifest. Cargo resolves every member of a
 * workspace against the lock next to the workspace root and ignores a
 * Cargo.lock inside a member directory. So when an ancestor directory holds a
 * `[workspace]` (from `workspaces`, keyed by root directory, '' for the repo
 * root) that lists or globs the manifest's directory and does not exclude it,
 * that root's lock is returned, or null when the root has none. Otherwise the
 * nearest lockfile walking up from the manifest's directory to the repo root
 * is used (a nested crate outside any workspace keeps its own lock). Returns
 * null when no lock applies. `lockPaths` holds the lock paths that exist.
 *
 * Pure function, exported for testing.
 */
export function nearestCargoLock(
  manifestPath: string,
  lockPaths: Set<string>,
  workspaces: Map<string, CargoWorkspace> = new Map(),
): string | null {
  const parts = manifestPath.split('/').slice(0, -1);
  const lockAt = (i: number) => (i === 0 ? 'Cargo.lock' : `${parts.slice(0, i).join('/')}/Cargo.lock`);

  for (let i = parts.length - 1; i >= 0; i--) {
    const ws = workspaces.get(parts.slice(0, i).join('/'));
    if (ws && isWorkspaceMember(ws, parts.slice(i).join('/'))) {
      const lock = lockAt(i);
      return lockPaths.has(lock) ? lock : null;
    }
  }
  for (let i = parts.length; i >= 0; i--) {
    if (lockPaths.has(lockAt(i))) return lockAt(i);
  }
  return null;
}

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
 * the crates they DECLARE. Deduped by crate name with first-seen (root-first)
 * wins. A virtual workspace root (only `[workspace]`, no `[dependencies]`)
 * contributes nothing of its own. Pure path-only `{ path = "../x" }` member
 * deps carry no version and are skipped by the parser.
 *
 * Workspace dependency inheritance is resolved: versions declared once in a
 * `[workspace.dependencies]` table are applied to member crates that opt in via
 * `serde = { workspace = true }`. An inherited dep whose name is absent from the
 * workspace table keeps an empty version (surfaced as UNKNOWN downstream) rather
 * than being dropped. Resolution only spans the discovered manifests; it does
 * not chase a workspace root outside the repo.
 *
 * Cargo.lock only sharpens the version of a declared crate: each manifest is
 * resolved against the lock of its workspace root when an ancestor `[workspace]`
 * lists it as a member (a stale Cargo.lock inside the member is ignored, as
 * Cargo does), otherwise against its nearest Cargo.lock (its own directory
 * first, then each ancestor up to the repo root), never against an unrelated
 * lock elsewhere in the tree, and a declared crate's requirement is replaced by the locked
 * version in that lock that satisfies it (highest on several matches). Crates
 * present only in the lock (transitive dependencies), and workspace-local, git
 * and alternate-registry packages, are never added.
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

  // Locked versions per crate name, kept separately for every lockfile found.
  const lockedByLock = new Map<string, Map<string, string[]>>();
  const lockContents = await fetchManifestContents(
    octokit,
    owner,
    repo,
    discoverCargoLockPaths(contents.map((c) => c.path)),
  );
  for (const { path, content } of lockContents) {
    const locked = new Map<string, string[]>();
    for (const dep of parseCargoLock(content)) {
      const versions = locked.get(dep.name) ?? [];
      if (!versions.includes(dep.version)) versions.push(dep.version);
      locked.set(dep.name, versions);
    }
    lockedByLock.set(path, locked);
  }
  const lockPaths = new Set(lockedByLock.keys());
  const workspaces = new Map<string, CargoWorkspace>();
  for (const { path, content } of contents) {
    const ws = parseCargoWorkspace(content, path);
    if (ws) workspaces.set(path.split('/').slice(0, -1).join('/'), ws);
  }

  // Pass 2: union member deps, resolving workspace-inherited versions, then
  // replacing each requirement by the version the lockfile resolved it to.
  const byName = new Map<string, CargoDep>();
  for (const { path, content } of contents) {
    const lockPath = nearestCargoLock(path, lockPaths, workspaces);
    const locked = (lockPath && lockedByLock.get(lockPath)) || new Map<string, string[]>();
    for (const dep of parseCargoToml(content)) {
      if (byName.has(dep.name)) continue;
      const requirement = dep.inheritsWorkspace
        ? (workspaceVersions.get(dep.name) ?? '')
        : dep.version;
      const exact = pickLockedVersion(requirement, locked.get(dep.name) ?? []);
      byName.set(dep.name, { name: dep.name, version: exact ?? requirement });
    }
  }

  return [...byName.values()];
}
