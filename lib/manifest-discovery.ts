import semver from 'semver';
import { createGitHubClient } from '@/lib/github';
import {
  type Ecosystem,
  type EcosystemInfo,
  SUPPORTED_ECOSYSTEMS,
  ecosystemPrecedence,
  manifestEcosystem,
} from '@/lib/ecosystem';

export interface TreeEntry {
  path?: string;
  type?: string;
}

export interface ManifestRef {
  path: string;
  ecosystem: Ecosystem;
}

// Directories whose manifests are never the project's own dependencies:
// installed packages, build output, third-party vendoring, and test scaffolding
// that ships throwaway package.json files. `examples/` is intentionally NOT
// excluded: monorepos commonly declare `examples/*` as real workspaces whose
// dependencies we want surfaced.
const EXCLUDED_DIR =
  /(^|\/)(node_modules|bower_components|\.next|\.nuxt|\.svelte-kit|dist|build|out|coverage|vendor|__fixtures__|__mocks__|fixtures|tmp)\//i;

// Hard cap so a pathological repo (e.g. committed node_modules that slipped the
// regex) can't fan out into thousands of registry lookups.
const MAX_MANIFESTS = 100;

function depth(path: string): number {
  return path.split('/').length;
}

/**
 * Pure: turn a flat git tree into the list of dependency manifests it contains,
 * excluding vendored/build/fixture directories. Ordered root-first (shallowest
 * paths first) so the repo-level manifest wins ties.
 */
export function selectManifestPaths(entries: TreeEntry[]): ManifestRef[] {
  const refs: ManifestRef[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    const ecosystem = manifestEcosystem(entry.path);
    if (!ecosystem) continue;
    refs.push({ path: entry.path, ecosystem });
  }
  refs.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  return refs.slice(0, MAX_MANIFESTS);
}

/**
 * Pure: choose the repo's primary ecosystem from its manifests. Prefers the
 * ecosystem of the shallowest manifest (root wins); on a tie at the same depth,
 * the one with the most manifests. Returns 'unknown' for an empty list.
 */
export function pickPrimaryEcosystem(refs: ManifestRef[]): Ecosystem {
  if (refs.length === 0) return 'unknown';
  const minDepth = Math.min(...refs.map((r) => depth(r.path)));
  // Among ecosystems present at the shallowest depth, pick the most frequent;
  // break ties by MANIFEST_MAP precedence (npm-first) so a polyglot root with
  // both package.json and e.g. go.mod resolves to npm, matching prior behaviour.
  const counts = new Map<Ecosystem, number>();
  for (const r of refs) {
    if (depth(r.path) === minDepth) counts.set(r.ecosystem, (counts.get(r.ecosystem) ?? 0) + 1);
  }
  let best: Ecosystem = 'unknown';
  let bestCount = -1;
  let bestPrec = Number.MAX_SAFE_INTEGER;
  for (const [eco, c] of counts) {
    const prec = ecosystemPrecedence(eco);
    if (c > bestCount || (c === bestCount && prec < bestPrec)) {
      best = eco;
      bestCount = c;
      bestPrec = prec;
    }
  }
  return best;
}

export interface ParsedNpmManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface UnionedDep {
  name: string;
  versionSpec: string;
  isDev: boolean;
}

/**
 * Pure: union prod + dev dependencies across every workspace/package manifest,
 * dropping workspace-internal references (a dep whose name is one of the local
 * manifests' own `name`). Deduped by package name; a prod occurrence outranks a
 * dev one.
 *
 * Version collapse (worst-case heuristic; no schema migration — see the
 * per-workspace-provenance follow-up below): if two workspaces pin the same
 * dep at different specs, the spec with the LOWEST minimum version admitted
 * by its semver range is kept, via `semver.minVersion` (already a project
 * dependency, see `lib/cve/osv.ts`), so an old, vulnerable pin in one
 * workspace is never hidden by a newer pin elsewhere (relevant for CVE /
 * dependency-age reporting).
 *
 * Non-semver specs (`workspace:`, `file:`, `link:`, a git/url spec, an `npm:`
 * alias, a dist-tag like `latest`) and the universal wildcard (`*`, `x`, `''`,
 * anything `semver.validRange` normalizes to `'*'`) are "non-comparable": their
 * minimum would trivially be `0.0.0`, which would otherwise make them "win"
 * every comparison despite pinning nothing real. The rule: a comparable spec
 * always beats a non-comparable one; when both are non-comparable the
 * incumbent (first-seen, root-first) is kept — the safe default when nothing
 * meaningful can be compared.
 *
 * The isDev flag is decided independently: a prod occurrence anywhere clears
 * it, regardless of which spec wins. Per-workspace version reporting needs
 * manifest provenance (a schema migration adding a workspace/manifestPath
 * dimension to Dependency) and is a deliberate follow-up, see task cac1b6fb.
 */
export function unionNpmDeps(manifests: ParsedNpmManifest[]): UnionedDep[] {
  const localNames = new Set(
    manifests.map((m) => m.name).filter((n): n is string => Boolean(n)),
  );
  const byName = new Map<string, UnionedDep>();

  // The lowest version a spec's semver range admits, or null when the spec is
  // "non-comparable": not a parseable semver range at all (`latest`,
  // `workspace:*`, `file:`, a git/url spec, an `npm:` alias — semver.validRange
  // returns null), or the universal wildcard (`*`, `x`, `''` — semver.validRange
  // normalizes all of these to `'*'`). The wildcard is excluded on purpose: its
  // minVersion is `0.0.0`, which would otherwise beat every concrete pin.
  const minComparableVersion = (spec: string): semver.SemVer | null => {
    const trimmed = spec.trim();
    const range = semver.validRange(trimmed);
    if (!range || range === '*') return null;
    try {
      return semver.minVersion(trimmed);
    } catch {
      return null;
    }
  };

  // Should `candidate` replace `incumbent` as the kept (lowest/oldest) spec?
  const specIsLower = (candidate: string, incumbent: string): boolean => {
    const mc = minComparableVersion(candidate);
    if (!mc) return false; // candidate non-comparable: never displaces the incumbent
    const mi = minComparableVersion(incumbent);
    if (!mi) return true; // comparable candidate beats a non-comparable incumbent
    return semver.lt(mc, mi);
  };

  const add = (name: string, spec: string, isDev: boolean) => {
    if (localNames.has(name)) return; // workspace-internal reference
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { name, versionSpec: spec, isDev });
      return;
    }
    // Two independent dimensions: keep the lowest spec seen, and clear isDev if
    // the package is a runtime (prod) dependency in ANY manifest.
    byName.set(name, {
      name,
      versionSpec: specIsLower(spec, existing.versionSpec) ? spec : existing.versionSpec,
      isDev: existing.isDev && isDev,
    });
  };

  for (const m of manifests) {
    for (const [name, spec] of Object.entries(m.dependencies ?? {})) add(name, String(spec), false);
    for (const [name, spec] of Object.entries(m.devDependencies ?? {})) add(name, String(spec), true);
  }

  return [...byName.values()];
}

/**
 * Detect the repo's primary ecosystem and every manifest path of that ecosystem
 * by walking the full git tree once. Falls back to a root-only probe when the
 * tree can't be read or comes back truncated, so single-root repos never
 * regress.
 */
export async function detectEcosystem(
  accessToken: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<EcosystemInfo> {
  const octokit = createGitHubClient(accessToken);

  let refs: ManifestRef[] = [];
  let needFallback = false;
  try {
    const ref = branch ?? (await resolveDefaultBranch(octokit, owner, repo));
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });
    refs = selectManifestPaths((data.tree ?? []) as TreeEntry[]);
    if (data.truncated) {
      // GitHub truncates trees above ~100k entries; the manifest set may be
      // incomplete. Rare, but log so an under-count isn't silent.
      console.warn(`[manifest-discovery] truncated git tree for ${owner}/${repo}; manifest set may be partial`);
    }
    if (data.truncated || refs.length === 0) needFallback = true;
  } catch {
    needFallback = true;
  }

  // Fallback: probe the repo root for manifests (legacy behaviour). Merge so a
  // truncated tree that already surfaced some manifests doesn't lose the root.
  if (needFallback) {
    const rootRefs = await probeRootManifests(octokit, owner, repo);
    const seen = new Set(refs.map((r) => r.path));
    for (const r of rootRefs) if (!seen.has(r.path)) refs.push(r);
    refs.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  }

  const primary = pickPrimaryEcosystem(refs);
  const manifestPaths = refs.filter((r) => r.ecosystem === primary).map((r) => r.path);

  return {
    ecosystem: primary,
    manifestFile: manifestPaths[0] ?? null,
    supported: SUPPORTED_ECOSYSTEMS.has(primary),
    manifestPaths,
  };
}

export type Octokit = ReturnType<typeof createGitHubClient>;

export interface FetchedManifest {
  path: string;
  content: string;
}

/**
 * Fetch the raw UTF-8 contents of the given repo paths, batched to bound
 * concurrency against GitHub secondary rate limits. Unreadable / missing files
 * are skipped so one bad path can't sink the whole scan. Results preserve the
 * input order, so a downstream first-seen-wins dedup is deterministic
 * (root-first when `paths` is root-first). The shared primitive behind every
 * ecosystem's multi-manifest read.
 */
export async function fetchManifestContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
): Promise<FetchedManifest[]> {
  const results: Array<FetchedManifest | null> = new Array(paths.length).fill(null);
  const BATCH_SIZE = 10; // bound concurrency to avoid secondary rate limits
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (path, j) => {
        try {
          const resp = await octokit.rest.repos.getContent({ owner, repo, path });
          if (!('content' in resp.data)) return;
          results[i + j] = {
            path,
            content: Buffer.from(resp.data.content, 'base64').toString('utf-8'),
          };
        } catch {
          // Missing or unreadable — skip it.
        }
      }),
    );
  }
  return results.filter((r): r is FetchedManifest => r !== null);
}

// ---- npm lockfile resolver -------------------------------------------------

interface NpmLockfileEntry {
  version?: string;
}

interface ParsedNpmLockfile {
  lockfileVersion?: number;
  /** lockfileVersion 2/3: map of install-path → entry */
  packages?: Record<string, NpmLockfileEntry>;
  /** lockfileVersion 1: flat dependency tree */
  dependencies?: Record<string, NpmLockfileEntry>;
}

// Simple numeric version comparison (no semver library; lockfile versions are
// exact, never range-prefixed, so triple-integer comparison is correct).
// Exported: also used by the yarn.lock resolver and by `mergeLockfileResolutions`.
export function lockfileVersionIsLower(a: string, b: string): boolean {
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

/**
 * Discover the `package-lock.json` paths that should be fetched for a given
 * set of `package.json` paths. Always includes the repo root lockfile; also
 * includes a co-located lockfile next to each discovered manifest.
 *
 * Pure function — exported for testing.
 */
export function discoverLockfilePaths(manifestPaths: string[]): string[] {
  const lockPathSet = new Set<string>();
  lockPathSet.add('package-lock.json'); // always probe repo root
  for (const p of manifestPaths) {
    const dir = p.split('/').slice(0, -1).join('/');
    // dir === '' means the package.json IS at the root → same file as above
    const lockPath = dir ? `${dir}/package-lock.json` : 'package-lock.json';
    lockPathSet.add(lockPath);
  }
  return [...lockPathSet];
}

/**
 * Parse a list of raw `package-lock.json` content strings (lockfileVersion
 * 1/2/3) and return a flat `packageName → resolvedVersion` map.
 *
 * For a package that appears in multiple lockfile entries (e.g. a workspace
 * root lockfile AND a per-package lockfile), the **lowest** resolved version
 * is kept, consistent with `unionNpmDeps`'s lowest-spec policy: if one
 * workspace has a vulnerable resolved version, it must not be hidden by a
 * newer resolution elsewhere.
 *
 * Known residual (full per-workspace provenance is task cac1b6fb): the map is
 * keyed by package name across all fetched lockfiles, not per manifest path. If
 * two workspaces pin the same dep to different version lines AND only the
 * higher-version workspace's lockfile is fetched (partial coverage), the query
 * uses that higher (safe) version and could hide the lower workspace's real
 * vuln. Complete coverage (the common npm-workspaces case with one root
 * lockfile) captures the lowest version and is safe; a total fetch failure
 * degrades to the manifest floor (also safe).
 *
 * Malformed JSON entries are skipped gracefully.
 *
 * Pure function — exported for testing.
 */
export function parseNpmLockfileContentsList(contents: string[]): Map<string, string> {
  const resolved = new Map<string, string>();

  const updateIfLower = (name: string, version: string): void => {
    if (!/\d/.test(version)) return; // skip non-concrete placeholders
    const existing = resolved.get(name);
    if (!existing || lockfileVersionIsLower(version, existing)) {
      resolved.set(name, version);
    }
  };

  for (const content of contents) {
    let lock: ParsedNpmLockfile;
    try {
      lock = JSON.parse(content) as ParsedNpmLockfile;
    } catch {
      continue; // malformed JSON — skip
    }

    if (lock.packages && typeof lock.packages === 'object') {
      // lockfileVersion 2/3: `packages` map.
      // Keys look like:
      //   ""                              → root package itself (skip)
      //   "node_modules/glob"             → top-level hoisted dep
      //   "node_modules/@babel/core"      → scoped dep
      //   "packages/a/node_modules/glob"  → workspace-nested dep
      for (const [key, entry] of Object.entries(lock.packages)) {
        if (!entry?.version) continue; // skip versionless entries
        // Take the package name after the LAST `node_modules/` segment. Handles
        // scoped (`@babel/core`) and deeply-nested
        // (`node_modules/a/node_modules/glob` → `glob`) keys. The root ("") and
        // workspace self-entries (e.g. `packages/a`) have no `node_modules/`
        // segment and are skipped.
        if (!key.includes('node_modules/')) continue;
        const name = key.split('node_modules/').pop();
        if (!name) continue;
        updateIfLower(name, entry.version);
      }
    } else if (lock.dependencies && typeof lock.dependencies === 'object') {
      // lockfileVersion 1: flat `dependencies` map (best-effort, top-level only).
      for (const [name, entry] of Object.entries(lock.dependencies)) {
        if (!entry?.version) continue;
        updateIfLower(name, entry.version);
      }
    }
  }

  return resolved;
}

/**
 * Given a list of package.json manifest paths, discover and fetch the
 * co-located `package-lock.json` files plus the repo root lockfile. Parse
 * them and return a flat `packageName → resolvedVersion` map.
 *
 * See `discoverLockfilePaths` and `parseNpmLockfileContentsList` for the
 * underlying pure logic. Missing or unreadable lockfiles are silently skipped
 * (404-safe). Returns an empty map when no lockfiles are found or all fail to
 * parse; the caller must fall back to the manifest-floor behaviour in that case.
 */
export async function fetchNpmLockfileResolutions(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[],
): Promise<Map<string, string>> {
  const lockPaths = discoverLockfilePaths(manifestPaths);
  const fetched = await fetchManifestContents(octokit, owner, repo, lockPaths);
  if (fetched.length === 0) return new Map<string, string>();
  return parseNpmLockfileContentsList(fetched.map((f) => f.content));
}

// ---- yarn.lock (v1 classic) resolver ---------------------------------------
//
// pnpm-lock.yaml is deliberately NOT covered here (task 3d20798a-0891-4dc6-
// b47c-5f259acff37e, scope cut from 2e68c0ab). Rationale: pnpm-lock.yaml is
// real YAML, and its shape changed materially across pnpm v7/v8/v9 (v9 split
// the top-level `packages`/`snapshots` maps and reworked import structure).
// A robust regex/indent parse across all three generations is not achievable
// with reasonable effort, and this codebase's convention is regex parsing
// with NO YAML/TOML library dependency (see the uv.lock/poetry.lock TOML
// parser in lib/manifests/python.ts, which is regex-based for the same
// reason). Introducing a YAML dependency just for this one lockfile was
// judged not worth it, especially since no repo in the current corpus uses
// pnpm. Deferred; the manifest-floor fallback still applies for pnpm repos
// (same behaviour as before this task).

/**
 * Discover the `yarn.lock` paths that should be fetched for a given set of
 * `package.json` paths. Mirrors `discoverLockfilePaths` (package-lock.json):
 * always probes the repo root, plus a co-located lockfile next to each
 * discovered manifest.
 *
 * Pure function, exported for testing.
 */
export function discoverYarnLockfilePaths(manifestPaths: string[]): string[] {
  const lockPathSet = new Set<string>();
  lockPathSet.add('yarn.lock'); // always probe repo root
  for (const p of manifestPaths) {
    const dir = p.split('/').slice(0, -1).join('/');
    const lockPath = dir ? `${dir}/yarn.lock` : 'yarn.lock';
    lockPathSet.add(lockPath);
  }
  return [...lockPathSet];
}

/**
 * Extract the package name from a single yarn.lock descriptor (one
 * already-unquoted entry of a header line's comma-separated list), e.g.
 * `glob@^10.3.0` → `glob`, `@babel/code-frame@^7.0.0` → `@babel/code-frame`.
 * A scoped name's own leading `@` is not the name/range separator, so the
 * search starts after it. Returns null when no `@` separator is found
 * (malformed descriptor).
 */
function yarnDescriptorName(descriptor: string): string | null {
  if (descriptor === '') return null;
  const searchFrom = descriptor.startsWith('@') ? 1 : 0;
  const at = descriptor.indexOf('@', searchFrom);
  return at === -1 ? null : descriptor.slice(0, at);
}

/**
 * Parse a yarn.lock header line's descriptor list (comma-separated, each
 * optionally double-quoted) into the set of package names it declares, e.g.
 * `"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.12.13"` → the single
 * name `@babel/code-frame` (deduped: every descriptor in one block resolves
 * to the same `version` field).
 */
function parseYarnDescriptors(header: string): string[] {
  const names = new Set<string>();
  for (const rawToken of header.split(',')) {
    let token = rawToken.trim();
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
      token = token.slice(1, -1);
    }
    const name = yarnDescriptorName(token);
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Parse a list of raw `yarn.lock` content strings (v1 "classic" format only,
 * see below) and return a flat `packageName → resolvedVersion` map.
 *
 * yarn.lock v1 is not YAML/JSON; it's yarn's own line-oriented format: a
 * header line at column 0 listing one or more comma-separated descriptors
 * (`name@range`, optionally double-quoted) terminated by `:`, followed by
 * 2-space-indented fields. Every descriptor in a block resolves to the same
 * `version "x.y.z"` field, so each of its names is mapped to that version.
 * First-match-wins for `version` within a block, mirroring the TOML
 * `[[package]]` block parser in `lib/manifests/python.ts` (protects against a
 * later indented field that happens to also read like a version line).
 *
 * yarn v2+ ("berry") lockfiles are NOT parsed here: they use a different
 * format (a top-level `__metadata:` header, different indentation/quoting).
 * A berry lockfile is detected via that `__metadata:` marker and skipped
 * whole for that content string, so it degrades to the manifest floor rather
 * than being mis-parsed as v1. This is a deliberate, documented deferral:
 * berry adoption is comparatively rare and out of scope for this task.
 *
 * For a package that appears in multiple entries (e.g. root lockfile +
 * multiple content strings), the LOWEST resolved version is kept, consistent
 * with `parseNpmLockfileContentsList`'s policy.
 *
 * Pure function, exported for testing.
 */
export function parseYarnLockfileContentsList(contentsList: string[]): Map<string, string> {
  const resolved = new Map<string, string>();

  const updateIfLower = (name: string, version: string): void => {
    if (!/\d/.test(version)) return; // skip non-concrete placeholders
    const existing = resolved.get(name);
    if (!existing || lockfileVersionIsLower(version, existing)) {
      resolved.set(name, version);
    }
  };

  for (const content of contentsList) {
    // Berry ("yarn v2+") lockfiles declare a top-level `__metadata:` key; skip
    // them rather than mis-parse them with the v1 line format.
    if (/^__metadata:/m.test(content)) continue;

    let blockNames: string[] = [];
    let blockVersion: string | null = null;

    const commitBlock = (): void => {
      if (blockVersion !== null) {
        for (const name of blockNames) updateIfLower(name, blockVersion);
      }
    };

    for (const rawLine of content.split('\n')) {
      if (rawLine.trim() === '' || rawLine.startsWith('#')) continue;

      // Header line: no leading whitespace, ends with ':'.
      if (!/^\s/.test(rawLine) && rawLine.trimEnd().endsWith(':')) {
        commitBlock(); // commit the previous block before starting the new one
        blockNames = parseYarnDescriptors(rawLine.trimEnd().slice(0, -1));
        blockVersion = null;
        continue;
      }

      if (blockVersion === null) {
        const versionMatch = /^\s+version\s+"([^"]+)"/.exec(rawLine);
        if (versionMatch) blockVersion = versionMatch[1];
      }
    }
    commitBlock(); // commit the final block in this content string
  }

  return resolved;
}

/**
 * Given a list of package.json manifest paths, discover and fetch the
 * co-located `yarn.lock` files plus the repo root lockfile. Parse them and
 * return a flat `packageName → resolvedVersion` map.
 *
 * See `discoverYarnLockfilePaths` and `parseYarnLockfileContentsList` for the
 * underlying pure logic. Missing or unreadable lockfiles are silently skipped
 * (404-safe). Returns an empty map when no lockfiles are found, every found
 * lockfile is berry-format, or all fail to parse; the caller must fall back
 * to the manifest-floor / npm-lockfile behaviour in that case.
 */
export async function fetchYarnLockfileResolutions(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[],
): Promise<Map<string, string>> {
  const lockPaths = discoverYarnLockfilePaths(manifestPaths);
  const fetched = await fetchManifestContents(octokit, owner, repo, lockPaths);
  if (fetched.length === 0) return new Map<string, string>();
  return parseYarnLockfileContentsList(fetched.map((f) => f.content));
}

/**
 * Merge multiple `packageName → resolvedVersion` maps (e.g. package-lock.json
 * and yarn.lock resolutions fetched for the same repo) into one, keeping the
 * LOWEST version per name across all inputs: the same security-conservative
 * policy each individual parser already applies internally. In practice a
 * repo ships exactly one JS lockfile format, so the maps rarely overlap; this
 * exists so a polyglot/transitional repo (e.g. a stray committed lockfile
 * from a package-manager migration) still can't have a vulnerable resolution
 * hidden behind a newer one from the other format.
 *
 * Pure function, exported for testing.
 */
export function mergeLockfileResolutions(maps: Array<Map<string, string>>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [name, version] of map) {
      const existing = merged.get(name);
      if (!existing || lockfileVersionIsLower(version, existing)) {
        merged.set(name, version);
      }
    }
  }
  return merged;
}

/**
 * Fetch and JSON-parse the given package.json paths. Unreadable or malformed
 * manifests are skipped, so one bad file can't sink the whole scan.
 */
export async function fetchNpmManifests(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
): Promise<ParsedNpmManifest[]> {
  const out: ParsedNpmManifest[] = [];
  for (const { content } of await fetchManifestContents(octokit, owner, repo, paths)) {
    try {
      out.push(JSON.parse(content) as ParsedNpmManifest);
    } catch {
      // Malformed JSON — skip it.
    }
  }
  return out;
}

async function resolveDefaultBranch(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

async function probeRootManifests(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
): Promise<ManifestRef[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: '' });
    if (!Array.isArray(data)) return [];
    const refs: ManifestRef[] = [];
    for (const f of data) {
      if (f.type !== 'file') continue;
      const ecosystem = manifestEcosystem(f.name);
      if (ecosystem) refs.push({ path: f.name, ecosystem });
    }
    return refs;
  } catch {
    return [];
  }
}
