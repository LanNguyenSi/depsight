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
 * Pure: pick the `package-lock.json` / `yarn.lock` paths out of a flat git
 * tree, applying the same vendored/build/fixture exclusion as
 * `selectManifestPaths`. This is the OBSERVED-existence counterpart to
 * `discoverLockfilePaths`/`discoverYarnLockfilePaths`' candidate GUESSING:
 * `detectEcosystem` already walks the full tree once to find manifestPaths,
 * so the lockfile paths that same tree also contains are captured here at
 * zero extra network cost, letting `fetchNpmLockfileResolutions` /
 * `fetchYarnLockfileResolutions` filter their guessed candidate list down to
 * paths already known to exist instead of probing every candidate over the
 * network (task c2ddfe93 — before this, N package.json files meant ~N extra
 * blind `getContent` probes per lockfile format, most of them 404s).
 */
export function selectLockfilePaths(entries: TreeEntry[]): { npm: string[]; yarn: string[] } {
  const npm: string[] = [];
  const yarn: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    const base = entry.path.split('/').pop();
    if (base === 'package-lock.json') npm.push(entry.path);
    else if (base === 'yarn.lock') yarn.push(entry.path);
  }
  return { npm, yarn };
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
 * `npm:` alias RESOLUTION (decided direction, task 18f6c239): a dependency
 * declared as `"localName": "npm:realName@range"` installs and resolves
 * `realName`, not `localName` — querying OSV under the local alias key reports
 * advisories for the wrong (and often nonexistent) package while hiding every
 * advisory that actually affects `realName`. Of the two options considered
 * (resolve to the real name, or drop the whole entry to a floor-only marker),
 * resolution is the one that never queries the wrong package: before dedup,
 * every `npm:` alias spec is parsed (`parseNpmAlias`) into its real name +
 * range and unioned under that real name instead of the manifest's local
 * key, so both the version comparison below and the final OSV query key are
 * the real package. A malformed alias (no parseable `@range` suffix) is left
 * as an unresolved raw spec and falls through to the non-comparable handling
 * below, same as any other unparseable spec — never silently dropped.
 * (Getting the query KEY right here is necessary but not sufficient for
 * never hiding an advisory end-to-end: the lockfile-resolution side needs
 * the matching real-name fix too — see the `NpmLockfileEntry.name`
 * preference in `parseNpmLockfileContentsList`, task 18f6c239 Finding 2, and
 * the floor-approximation caveat on the `ambiguous` fallback in
 * `collectDeps`, Finding 1 — this function alone only guarantees the query
 * is never mis-keyed.)
 *
 * Version collapse (worst-case heuristic; no schema migration — see the
 * per-workspace-provenance follow-up below): if two workspaces pin the same
 * dep at different specs, the spec with the LOWEST minimum version admitted
 * by its semver range is kept, via `semver.minVersion` (already a project
 * dependency, see `lib/cve/osv.ts`), so an old, vulnerable pin in one
 * workspace is never hidden by a newer pin elsewhere (relevant for CVE /
 * dependency-age reporting).
 *
 * Non-semver specs (`workspace:`, `file:`, `link:`, a git/url spec, a
 * malformed/unresolved `npm:` alias, a dist-tag like `latest`) and the
 * universal wildcard (`*`, `x`, `''`, anything `semver.validRange` normalizes
 * to `'*'`) are "non-comparable": their minimum would trivially be `0.0.0`,
 * which would otherwise make them "win" every comparison despite pinning
 * nothing real. The rule: a comparable spec always beats a non-comparable
 * one; when both are non-comparable the incumbent (first-seen, root-first) is
 * kept — the safe default when nothing meaningful can be compared.
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

  // Resolve an `npm:` alias entry to its real name + range before unioning
  // (see the `npm:` alias RESOLUTION paragraph in the docstring above); a
  // non-alias or unparseable-alias entry passes through unchanged.
  const resolveAliasedEntry = (name: string, spec: string): { name: string; spec: string } => {
    const alias = parseNpmAlias(spec);
    return alias ? { name: alias.realName, spec: alias.realSpec } : { name, spec };
  };

  for (const m of manifests) {
    for (const [name, spec] of Object.entries(m.dependencies ?? {})) {
      const resolved = resolveAliasedEntry(name, String(spec));
      add(resolved.name, resolved.spec, false);
    }
    for (const [name, spec] of Object.entries(m.devDependencies ?? {})) {
      const resolved = resolveAliasedEntry(name, String(spec));
      add(resolved.name, resolved.spec, true);
    }
  }

  return [...byName.values()];
}

/**
 * Parse an `npm:` alias dependency spec (`npm:realName@range`, e.g.
 * `npm:lodash-es@^4.0.0`, or a scoped `npm:@scope/pkg@^1.0.0`) into the REAL
 * package name and range it points at. Returns null when `spec` isn't an
 * `npm:` alias at all, or has no parseable `@range` suffix (a malformed or
 * unsupported form, e.g. a bare `npm:realName` with no version) — the caller
 * then treats the raw spec as an ordinary, non-comparable string, same as any
 * other unparseable spec, rather than guessing.
 *
 * Mirrors the scoped-name-aware `@`-search in `yarnDescriptorName` (a scoped
 * real name's own leading `@` is not the name/range separator).
 */
function parseNpmAlias(spec: string): { realName: string; realSpec: string } | null {
  const trimmed = spec.trim();
  if (!trimmed.startsWith('npm:')) return null;
  const aliased = trimmed.slice(4);
  const searchFrom = aliased.startsWith('@') ? 1 : 0;
  const at = aliased.indexOf('@', searchFrom);
  if (at === -1) return null; // no `@range` suffix — malformed/unsupported alias
  const realName = aliased.slice(0, at);
  const realSpec = aliased.slice(at + 1);
  if (!realName || !realSpec) return null;
  return { realName, realSpec };
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
  let observedLockfilePaths: { npm: string[]; yarn: string[] } | null = null;
  let needFallback = false;
  try {
    const ref = branch ?? (await resolveDefaultBranch(octokit, owner, repo));
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });
    const tree = (data.tree ?? []) as TreeEntry[];
    refs = selectManifestPaths(tree);
    if (data.truncated) {
      // GitHub truncates trees above ~100k entries; the manifest set may be
      // incomplete. Rare, but log so an under-count isn't silent.
      console.warn(`[manifest-discovery] truncated git tree for ${owner}/${repo}; manifest set may be partial`);
    } else {
      // Only trust the observed lockfile set when the tree walk is COMPLETE:
      // a truncated tree may be missing lockfiles that exist beyond the cut,
      // and filtering candidates against a partial set could silently skip a
      // real lockfile. A truncated/failed walk leaves this null so
      // downstream fetchers fall back to blind-probing every candidate, same
      // as before this task.
      observedLockfilePaths = selectLockfilePaths(tree);
    }
    if (data.truncated || refs.length === 0) needFallback = true;
  } catch {
    needFallback = true;
  }

  // Fallback: probe the repo root for manifests (legacy behaviour). Merge so a
  // truncated tree that already surfaced some manifests doesn't lose the root.
  if (needFallback) {
    // Any fallback (exception, truncated tree, or a walk that yielded zero
    // manifest refs and is being patched up via the root probe) means the
    // observed set does not describe the tree the fetched manifests came
    // from - it must not be used to filter candidates (Finding 1, R1).
    observedLockfilePaths = null;
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
    observedLockfilePaths,
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

// ---- lockfile resolution + ambiguous-fallback shared helpers ---------------
//
// Both the npm and yarn.lock parsers below (and their cross-format merge)
// share the same D-006 conflict handling: a bare package name that resolves
// to 2+ DISTINCT versions across entries/blocks/maps is dropped from the
// primary `resolved` map (see the D-006 doc comments on each parser below).
// Task 18f6c239 Finding 1 fix: on top of that drop, the LOWEST of the
// conflicting versions is ALSO kept, in a separate `ambiguous` map, so
// `collectDeps` (lib/cve/osv.ts) has a last-resort fallback for a dependency
// whose manifest spec carries no usable version EITHER (e.g. `*`, `latest`,
// `workspace:*`, a git spec whose URL contains no digit). Without this, such a dependency
// was silently dropped from the OSV scan entirely whenever its lockfile
// resolution was ambiguous (measured: 0 OSV queries instead of 3 for a small
// reproduction repo, where the pre-fix docstring's "may over-report via the
// floor, never silence" claim did not actually hold). D-006 itself is
// unchanged: a usable `resolved` entry, or a usable manifest floor, still
// always wins over this fallback — see the `??`/floor/`ambiguous` chain in
// `collectDeps`. The resulting invariant: a declared dependency for which ANY
// USABLE version information exists anywhere (lockfile, a manifest spec that
// resolves to an exact or range-derived floor, or an `ambiguous` lockfile
// entry) always produces an OSV query. The one documented exception: a
// digit-bearing manifest spec that is neither a real semver version nor a
// parseable semver range (a git ref, an unsupported `npm:` alias form — see
// the alias paragraph on `unionNpmDeps` above) with no `ambiguous` entry to
// fall back to is dropped from the scan, same as any other dep with no
// usable version anywhere.
//
// "Usable manifest floor" (task 7fc55e6f, R2 finding on 18f6c239): `collectDeps`
// derives the floor by stripping the leading non-digit prefix off the raw
// manifest spec (e.g. `^2.5.0` -> `2.5.0`). Gating that floor's usability on
// merely "non-empty" was wrong: a non-semver spec whose text happens to
// contain a digit (e.g. a git spec `github:acme/widget2#main`) strips down to
// a non-empty but meaningless value (`2#main`) — that value must NOT be sent
// to OSV as if it were a real version. Measured against
// api.osv.dev/v1/querybatch (not assumed): such an unparseable version string
// is NOT silently unmatchable — OSV returns an ARBITRARY, unfiltered result
// set for it (`lodash@"2#main"` returned 5 vulns in the same batch where
// `lodash@"999.0.0"` returned 0 and the real resolved version returned the
// correct 10, and `fetchOsvAdvisories` applies no further local version
// filter to what OSV returns). So the old floor risked arbitrary
// OVER-reporting for that dep, not the "effectively unscanned" silence the
// pre-fix docstring assumed — a real observed version is preferred whenever
// one is available. Raising the guard to plain `semver.valid(floor) !== null`
// would, however, also reject a floor derived from an ordinary, legitimate
// RANGE spec (`^19`, `~1.2`, `2.x`, `>=1.2` — measured across the pandora
// corpus: 65/1316 manifest specs, 4.9%, are in this class, all legitimate
// ranges, zero git refs), since a range's floor-strip is rarely a full
// `x.y.z`. `collectDeps` therefore tries `semver.validRange` against the RAW
// spec (not the floor) as a second path before giving up on the floor
// entirely, and uses `semver.minVersion` of that range as the query version
// (`^19` -> `19.0.0`) — more precise than the pre-task raw-floor value would
// have been for the same range. Only a spec that fails BOTH the exact-version
// and the range check (the git-ref case above, or a malformed/unsupported
// `npm:` alias — see below) reaches the `ambiguous` fallback or drop. An
// `npm:real@^2.0.0` alias with a WELL-FORMED `name@range` suffix is resolved
// to its real name and range by `unionNpmDeps`'s own alias handling (see the
// `npm:` alias paragraph on `unionNpmDeps` above) before `collectDeps` ever
// computes a floor from it, regardless of whether the real name or range
// contains a digit (`npm:h3@^1.0.0` resolves cleanly to name `h3`, range
// `^1.0.0`, floor `1.0.0`) — so it is unaffected by this change either way. Only a
// MALFORMED/unsupported alias form that `unionNpmDeps`'s alias parser can't
// parse (e.g. a bare `npm:h3` with no `@range` suffix) is passed through
// unresolved, and can then floor to an invalid, digit-bearing value the same
// way a git ref does; that residual gap is out of scope for this task (no
// alias parsing changes here) and is pinned by a test as a known limitation.
// D-006's ordering is unchanged either way: resolved > usable floor (exact or
// range-derived) > ambiguous.

export interface LockfileResolutions {
  /** name -> single unambiguous resolved version (D-006 semantics, unchanged). */
  resolved: Map<string, string>;
  /**
   * name -> LOWEST version observed among 2+ conflicting entries recorded
   * for that name (task 18f6c239 Finding 1). Populated only for names
   * dropped from `resolved` by the conflict rule; a name present in
   * `resolved` may still carry a stale/unused `ambiguous` entry too (e.g.
   * from a same-format conflict that a different format's agreement later
   * settled) — harmless, since callers only consult `ambiguous` when
   * `resolved` has no entry for the name.
   */
  ambiguous: Map<string, string>;
}

/**
 * Given two DISTINCT version strings observed for the same package name,
 * return whichever is lower — the more conservative (more likely
 * still-vulnerable) candidate for the `ambiguous` fallback map. Compared via
 * semver when both parse as valid versions; when either doesn't, the
 * first-seen value (`a`) is kept (arbitrary but deterministic — an
 * unparseable version string won't match an OSV advisory either way).
 */
function pickLowerVersion(a: string, b: string): string {
  const va = semver.valid(a);
  const vb = semver.valid(b);
  if (va && vb) return semver.lt(va, vb) ? a : b;
  // When exactly one operand parses, keep the parseable one: it is the only
  // version that can match an OSV advisory. Only when neither parses does the
  // first-seen value win (deterministic-but-arbitrary; unmatchable either way).
  if (va && !vb) return a;
  if (!va && vb) return b;
  return a;
}

/**
 * Shared conflict tracker behind `parseNpmLockfileContentsList`,
 * `parseYarnLockfileContentsList`, and the cross-format merge in
 * `mergeLockfileResolutions`: record one (name, version) observation. A name
 * seen at a single distinct version stays in `resolved`. A name seen at 2+
 * DISTINCT versions is dropped from `resolved` and tracked in `ambiguous` at
 * its LOWEST observed version instead — sticky, like the pre-existing
 * per-parser `conflicted` sets this replaces, so it stays dropped even if a
 * later observation happens to re-agree with an earlier value (the true
 * resolution is genuinely ambiguous given everything seen so far). Ignores
 * non-concrete (no-digit) version strings.
 */
function createResolutionTracker(): {
  record: (name: string, version: string) => void;
  result: () => LockfileResolutions;
} {
  const resolved = new Map<string, string>();
  const ambiguous = new Map<string, string>();
  const conflicted = new Set<string>();

  const record = (name: string, version: string): void => {
    if (!/\d/.test(version)) return; // skip non-concrete placeholders
    if (conflicted.has(name)) {
      const lowest = ambiguous.get(name);
      ambiguous.set(name, lowest === undefined ? version : pickLowerVersion(lowest, version));
      return;
    }
    const existing = resolved.get(name);
    if (existing === undefined) {
      resolved.set(name, version);
    } else if (existing !== version) {
      resolved.delete(name);
      conflicted.add(name);
      ambiguous.set(name, pickLowerVersion(existing, version));
    }
    // existing === version: same resolution seen again, no-op.
  };

  return { record, result: () => ({ resolved, ambiguous }) };
}

// ---- npm lockfile resolver -------------------------------------------------

interface NpmLockfileEntry {
  version?: string;
  /**
   * npm writes this on an ALIASED install, e.g.
   * `"node_modules/myLodash": { "name": "lodash-es", "version": "4.17.21" }`
   * — the key's last path segment is the LOCAL alias, not the installed
   * package. See the `entry.name` preference in the lockfileVersion 2/3
   * branch of `parseNpmLockfileContentsList` below (task 18f6c239 Finding 2).
   */
  name?: string;
}

interface ParsedNpmLockfile {
  lockfileVersion?: number;
  /** lockfileVersion 2/3: map of install-path → entry */
  packages?: Record<string, NpmLockfileEntry>;
  /** lockfileVersion 1: flat dependency tree */
  dependencies?: Record<string, NpmLockfileEntry>;
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
 * The map is keyed by bare package name across ALL entries and ALL content
 * strings in `contents`, not per manifest/workspace (same simplification as
 * `parseYarnLockfileContentsList`; see task cac1b6fb for the per-workspace
 * provenance follow-up). A workspace-nested entry
 * (`packages/a/node_modules/glob`) collapses onto the same bare name as a
 * top-level hoisted entry (`node_modules/glob`), and — critically — so does a
 * deeply-nested transitive under a DIFFERENT package's tree
 * (`node_modules/foo/node_modules/glob`): the two can legitimately resolve to
 * different versions, and there is no per-manifest scoping here to
 * disambiguate which entry is "the" resolution for a declared dependency.
 *
 * Per orchestrator decision D-006 (ambiguity degrades to the manifest floor,
 * everywhere — this path is now aligned with `parseYarnLockfileContentsList`,
 * closing the exception that used to be documented here, task 18f6c239): when
 * a bare name resolves to more than one DISTINCT version across
 * entries/content strings, that name is dropped from the map entirely, rather
 * than guessing via lowest-wins (which can pick an unrelated, wrong
 * resolution and silently clear a real advisory — measured on depsight's own
 * package-lock.json: a direct `semver@^7.8.5` was shadowed by an unrelated
 * nested `semver@6.3.1`, so OSV was queried at 6.3.1 instead of the correct
 * 7.8.5 floor) or semver-range intersection (explicitly deferred, not
 * implemented here). The caller (`collectDeps` in `lib/cve/osv.ts`) then falls
 * back to the manifest-floor version for that dep, matching
 * pre-lockfile-resolution behaviour — unless `mergeLockfileResolutions`' one-
 * sided rule finds an unambiguous resolution from the OTHER lockfile format
 * (the drop is not propagated as a cross-format poison set; per-format
 * ambiguity provenance is part of the cac1b6fb follow-up).
 *
 * The return value pairs that `resolved` map with an `ambiguous` one (task
 * 18f6c239 Finding 1) — see the shared-helpers banner above
 * `LockfileResolutions` for the full ambiguous-fallback rationale (including
 * what counts as a "usable" floor, task 7fc55e6f) and the D-006 ordering
 * invariant that `collectDeps` (`lib/cve/osv.ts`) applies when consuming it.
 * The resulting invariant: a declared dependency for which ANY USABLE version
 * information exists anywhere (lockfile, an exact-or-range-parseable manifest
 * spec, or an `ambiguous` entry) always produces an OSV query; a usable
 * `resolved` entry or manifest floor still always wins over the `ambiguous`
 * fallback. The one documented exception (task 7fc55e6f): a digit-bearing
 * spec that parses as neither a real semver version nor a semver range (a
 * git ref, an unsupported `npm:` alias form) with no `ambiguous` entry to
 * fall back to is dropped from the scan.
 *
 * Also resolves npm's ALIASED installs (task 18f6c239 Finding 2): in the
 * lockfileVersion 2/3 `packages` map, an aliased entry carries the real
 * package's `name` field (e.g. `"node_modules/myLodash": { "name":
 * "lodash-es", ... }`) — see the `NpmLockfileEntry.name` doc comment above.
 * That real name is preferred over the key-derived one so an aliased install
 * and a direct install of the same real package register (and, per D-006,
 * conflict) under the SAME name, matching the manifest-side alias resolution
 * in `unionNpmDeps`.
 *
 * Malformed JSON entries are skipped gracefully.
 *
 * Pure function — exported for testing.
 */
export function parseNpmLockfileContentsList(contents: string[]): LockfileResolutions {
  const tracker = createResolutionTracker();

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
        // The root ("") and workspace self-entries (e.g. `packages/a`) have
        // no `node_modules/` segment and are skipped.
        if (!key.includes('node_modules/')) continue;
        // Prefer the entry's own `name` field when npm wrote one (an ALIASED
        // install, see NpmLockfileEntry.name above); otherwise take the
        // package name after the LAST `node_modules/` segment. That segment
        // approach handles scoped (`@babel/core`) and deeply-nested
        // (`node_modules/a/node_modules/glob` → `glob`) keys, but for an
        // aliased entry it would yield the LOCAL alias instead of the real
        // package — losing the resolution, and (the security-relevant case)
        // letting a direct, safe install of the same real package silently
        // absorb the OSV query while the vulnerable aliased install is never
        // queried at all (task 18f6c239 Finding 2).
        const name = entry.name || key.split('node_modules/').pop();
        if (!name) continue;
        tracker.record(name, entry.version);
      }
    } else if (lock.dependencies && typeof lock.dependencies === 'object') {
      // lockfileVersion 1: flat `dependencies` map (best-effort, top-level only).
      for (const [name, entry] of Object.entries(lock.dependencies)) {
        if (!entry?.version) continue;
        tracker.record(name, entry.version);
      }
    }
  }

  return tracker.result();
}

/**
 * Given a list of package.json manifest paths, discover and fetch the
 * co-located `package-lock.json` files plus the repo root lockfile. Parse
 * them and return a flat `packageName → resolvedVersion` map.
 *
 * See `discoverLockfilePaths` and `parseNpmLockfileContentsList` for the
 * underlying pure logic. Missing or unreadable lockfiles are silently skipped
 * (404-safe). Returns empty `resolved`/`ambiguous` maps when no lockfiles are
 * found or all fail to parse; the caller must fall back to the manifest-floor
 * behaviour in that case.
 *
 * `observedLockfilePaths` (task c2ddfe93, dedup of blind probes): when the
 * caller already knows (from `EcosystemInfo.observedLockfilePaths.npm`,
 * itself derived from `detectEcosystem`'s single git-tree walk) exactly which
 * `package-lock.json` paths exist in the repo, pass that list here so the
 * candidate paths from `discoverLockfilePaths` are filtered down to only the
 * ones known to exist before hitting the network — instead of probing every
 * co-located candidate and eating a 404 for each one that doesn't exist.
 * `undefined`/`null` (the default) preserves the pre-task blind-probe
 * behaviour: every candidate is fetched, existence unknown ahead of time.
 */
export async function fetchNpmLockfileResolutions(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[],
  observedLockfilePaths?: string[] | null,
): Promise<LockfileResolutions> {
  const candidatePaths = discoverLockfilePaths(manifestPaths);
  const observedSet =
    observedLockfilePaths == null ? null : new Set(observedLockfilePaths.map((p) => p.toLowerCase()));
  const lockPaths = observedSet == null ? candidatePaths : candidatePaths.filter((p) => observedSet.has(p.toLowerCase()));
  const fetched = await fetchManifestContents(octokit, owner, repo, lockPaths);
  if (fetched.length === 0) return { resolved: new Map(), ambiguous: new Map() };
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
// judged not worth it. As of 2026-08, no repo in the scanned corpus was
// observed using pnpm — an observation at that date, not a guarantee for the
// future. Deferred; the manifest-floor fallback still applies for pnpm repos
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
 *
 * Mirrors the scoped-name-aware `@`-search in `parseNpmAlias` (an `npm:`
 * alias's own real name can also be scoped).
 */
function yarnDescriptorName(descriptor: string): string | null {
  if (descriptor === '') return null;
  const searchFrom = descriptor.startsWith('@') ? 1 : 0;
  const at = descriptor.indexOf('@', searchFrom);
  return at === -1 ? null : descriptor.slice(0, at);
}

/**
 * Split a yarn.lock header's descriptor list on top-level commas, i.e. commas
 * OUTSIDE a double-quoted descriptor. A single descriptor's version range can
 * itself contain a comma (e.g. `"lodash@>=1.0.0, <2.0.0"`); splitting on
 * every comma unconditionally would tear that one quoted descriptor into two
 * corrupt tokens BEFORE quote-stripping ever runs (e.g. a dangling `"lodash`
 * key). Quotes are tracked one character at a time; yarn.lock descriptors
 * never contain an escaped quote, so no escape handling is needed.
 */
function splitDescriptorsRespectingQuotes(header: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  tokens.push(current);
  return tokens;
}

/**
 * Parse a yarn.lock header line's descriptor list (comma-separated, each
 * optionally double-quoted) into the set of package names it declares, e.g.
 * `"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.12.13"` → the single
 * name `@babel/code-frame` (deduped: every descriptor in one block resolves
 * to the same `version` field). Splits on commas OUTSIDE quotes first (see
 * `splitDescriptorsRespectingQuotes`) so a quoted descriptor whose own range
 * contains a comma isn't torn apart before its quotes are stripped.
 */
function parseYarnDescriptors(header: string): string[] {
  const names = new Set<string>();
  for (const rawToken of splitDescriptorsRespectingQuotes(header)) {
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
 * berry adoption is comparatively rare and out of scope for this task. As a
 * second, independent line of defense, berry's own `version: x.y.z` field
 * syntax (colon, unquoted) never matches this parser's v1 `version "x.y.z"`
 * regex anyway, so even a missed/bypassed marker check degrades to an empty
 * map for that content string rather than mis-parsing berry fields.
 *
 * The map is keyed by bare package name across ALL blocks and ALL content
 * strings in `contentsList`, not per manifest/workspace (same simplification
 * as `parseNpmLockfileContentsList`; see task cac1b6fb for the per-workspace
 * provenance follow-up). Two unrelated blocks can legitimately resolve the
 * same bare name to different versions (e.g. a `glob@^7.x` transitive pin
 * from one package's tree alongside a `glob@^10.x` direct pin declared by the
 * manifest) — there is no per-manifest scoping here to disambiguate which
 * block is "the" resolution for the declared dep.
 *
 * Per orchestrator decision D-006 (ambiguity degrades to the manifest floor,
 * everywhere): when a bare name resolves to more than one DISTINCT version
 * across blocks/content strings, that name is dropped from the map entirely,
 * rather than guessing via lowest-wins (which can pick an unrelated, wrong
 * resolution) or semver-range intersection (explicitly deferred, not
 * implemented here). The caller (`collectDeps` in `lib/cve/osv.ts`) then
 * falls back to the manifest-floor version for that dep, matching
 * pre-lockfile-resolution behaviour — unless another lockfile format
 * independently resolves that name, in which case `mergeLockfileResolutions`'
 * one-sided rule uses that resolution (the drop is not propagated as a
 * cross-format poison set; per-format ambiguity provenance is part of the
 * cac1b6fb follow-up). It never trusts a resolution that can't be tied
 * unambiguously to one version, at the cost of occasionally under-using a
 * genuinely-available exact resolution when two unrelated blocks happen to
 * share a bare name.
 *
 * The return value pairs that `resolved` map with an `ambiguous` one (task
 * 18f6c239 Finding 1), same shared mechanism as `parseNpmLockfileContentsList`
 * — see the shared-helpers banner above `LockfileResolutions` for the full
 * ambiguous-fallback rationale.
 *
 * Pure function, exported for testing.
 */
export function parseYarnLockfileContentsList(contentsList: string[]): LockfileResolutions {
  const tracker = createResolutionTracker();

  for (const content of contentsList) {
    // Berry ("yarn v2+") lockfiles declare a top-level `__metadata:` key; skip
    // them rather than mis-parse them with the v1 line format.
    if (/^__metadata:/m.test(content)) continue;

    let blockNames: string[] = [];
    let blockVersion: string | null = null;

    const commitBlock = (): void => {
      if (blockVersion !== null) {
        for (const name of blockNames) tracker.record(name, blockVersion);
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

  return tracker.result();
}

/**
 * Given a list of package.json manifest paths, discover and fetch the
 * co-located `yarn.lock` files plus the repo root lockfile. Parse them and
 * return a flat `packageName → resolvedVersion` map.
 *
 * See `discoverYarnLockfilePaths` and `parseYarnLockfileContentsList` for the
 * underlying pure logic. Missing or unreadable lockfiles are silently skipped
 * (404-safe). Returns empty `resolved`/`ambiguous` maps when no lockfiles are
 * found, every found lockfile is berry-format, or all fail to parse; the
 * caller must fall back to the manifest-floor / npm-lockfile behaviour in
 * that case.
 *
 * `observedLockfilePaths` (task c2ddfe93, dedup of blind probes): mirrors the
 * parameter of the same name on `fetchNpmLockfileResolutions` — when the
 * caller already knows (from `EcosystemInfo.observedLockfilePaths.yarn`)
 * exactly which `yarn.lock` paths exist, pass that list to fetch only those
 * instead of blindly probing every co-located candidate. This is the common
 * case where the reduction matters most: a repo using npm (or with no JS
 * lockfile at all) has ZERO yarn.lock paths, so this drops the entire yarn
 * discovery pass's network calls to zero instead of one 404 per candidate.
 * `undefined`/`null` (the default) preserves the pre-task blind-probe
 * behaviour.
 */
export async function fetchYarnLockfileResolutions(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[],
  observedLockfilePaths?: string[] | null,
): Promise<LockfileResolutions> {
  const candidatePaths = discoverYarnLockfilePaths(manifestPaths);
  const observedSet =
    observedLockfilePaths == null ? null : new Set(observedLockfilePaths.map((p) => p.toLowerCase()));
  const lockPaths = observedSet == null ? candidatePaths : candidatePaths.filter((p) => observedSet.has(p.toLowerCase()));
  const fetched = await fetchManifestContents(octokit, owner, repo, lockPaths);
  if (fetched.length === 0) return { resolved: new Map(), ambiguous: new Map() };
  return parseYarnLockfileContentsList(fetched.map((f) => f.content));
}

/**
 * Merge multiple `{ resolved, ambiguous }` lockfile-resolution results (e.g.
 * package-lock.json and yarn.lock resolutions fetched for the same repo)
 * into one. In practice a repo ships exactly one JS lockfile format, so the
 * inputs rarely overlap; this exists so a polyglot/transitional repo (e.g. a
 * stray committed lockfile left over from a package-manager migration) is
 * still handled deterministically.
 *
 * `resolved` merge semantics follow the pre-18f6c239 shape with one
 * deliberate tightening: inputs are re-run through the shared tracker, so a
 * version without any digit (e.g. a hand-crafted `latest`) is filtered from
 * the merged `resolved` map — strictly safer, as both parsers pre-filter the
 * same way. Otherwise (see the `ambiguous` paragraph below): per orchestrator
 * decision D-006 (ambiguity degrades to the manifest floor, everywhere), a
 * name present in only ONE input's `resolved` map uses that map's version
 * as-is. A name present in MORE THAN ONE input's `resolved` map is kept ONLY
 * when all the versions AGREE; when they DISAGREE, the name is dropped from
 * the merged `resolved` map entirely so the caller (`collectDeps` in
 * `lib/cve/osv.ts`) falls back to the manifest floor for that dep, rather
 * than trusting either lockfile's resolution over the other.
 *
 * This deliberately does NOT give npm's package-lock.json precedence over
 * yarn.lock (or vice versa) on disagreement, and does NOT keep the lower of
 * the two versions: either fixed policy can point the wrong way. A stale
 * package-lock.json left behind by a package-manager migration can carry a
 * HIGHER version than the yarn.lock that reflects the actual install, so
 * "npm wins" (or "lower wins", which would agree with npm here) both mask
 * the real, yarn-resolved vulnerable version behind a stale, safer-looking
 * npm one. Dropping to the floor on disagreement is conservative in the
 * false-negative direction regardless of which lockfile is actually stale.
 *
 * `ambiguous` (task 18f6c239 Finding 1, additive): the merged `ambiguous` map
 * unions every input's own `ambiguous` entries AND every name this merge
 * itself drops from `resolved` on cross-format disagreement, keeping the
 * LOWEST version recorded per name across all of those sources — the same
 * last-resort fallback `collectDeps` reads when a dep has neither a
 * `resolved` entry nor a usable manifest floor. See the shared-helpers
 * banner above `LockfileResolutions` for the full rationale.
 *
 * Pure function, exported for testing.
 */
export function mergeLockfileResolutions(
  results: LockfileResolutions[],
): LockfileResolutions {
  const tracker = createResolutionTracker();
  for (const { resolved } of results) {
    for (const [name, version] of resolved) {
      tracker.record(name, version);
    }
  }
  const merged = tracker.result();

  // Union each input's own `ambiguous` map into the merged one too, keeping
  // the lowest version per name across every source (a same-format conflict
  // that never touched `resolved`, AND a cross-format `resolved` disagreement
  // just recorded above).
  for (const { ambiguous } of results) {
    for (const [name, version] of ambiguous) {
      const existing = merged.ambiguous.get(name);
      merged.ambiguous.set(
        name,
        existing === undefined ? version : pickLowerVersion(existing, version),
      );
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
