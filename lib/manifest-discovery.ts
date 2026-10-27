import semver from 'semver';
import { createGitHubClient } from '@/lib/github';
import {
  type Ecosystem,
  type EcosystemInfo,
  SUPPORTED_ECOSYSTEMS,
  ecosystemPrecedence,
  manifestEcosystem,
} from '@/lib/ecosystem';
import { confirmRepositoryReadable, isNothingThere, noteDegraded } from '@/lib/scan/degraded';

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
  return collectManifestRefs(entries).slice(0, MAX_MANIFESTS);
}

// Every manifest of the tree, root-first, BEFORE the MAX_MANIFESTS cut.
// `selectManifestPaths` slices it; `detectEcosystem` also reads its length to
// record whether the cut dropped anything (`ObservedTreeFacts.manifestsCapped`).
function collectManifestRefs(entries: TreeEntry[]): ManifestRef[] {
  const refs: ManifestRef[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    const ecosystem = manifestEcosystem(entry.path);
    if (!ecosystem) continue;
    refs.push({ path: entry.path, ecosystem });
  }
  refs.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  return refs;
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

// Lockfile kinds the npm resolver in this file does not read. A repo that
// carries any of them has a package manager whose installs the
// `package-lock.json` files cannot vouch for (`npm-shrinkwrap.json` even takes
// precedence over `package-lock.json` for npm itself).
const FOREIGN_LOCKFILE_NAMES = new Set([
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'deno.lock',
]);

// Configuration files of other package managers. They change what an install
// does (pnpm workspaces, yarn settings, pnpm hooks) without a lockfile saying
// so, so their presence anywhere keeps every baseline entry.
const PACKAGE_MANAGER_CONFIG_NAMES = new Set([
  'pnpm-workspace.yaml',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
]);

/**
 * Facts about the git-tree walk that `observedLockfilePaths` does not carry,
 * recorded in the same single walk. They exist for the narrow override in
 * `resolveNarrowNpm`; nothing that decides what the fetchers fetch reads them.
 */
export interface ObservedTreeFacts {
  /**
   * Paths of every `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`,
   * `npm-shrinkwrap.json` and `deno.lock` in the (non-excluded) tree.
   */
  foreignLockfilePaths: string[];
  /** The manifest list hit MAX_MANIFESTS, so manifests beyond the cut are unknown. */
  manifestsCapped: boolean;
  /**
   * Paths of every `.npmrc` in the (non-excluded) tree. An `.npmrc` can change
   * what npm installs (`package-lock=false`, registry and `omit` settings), so
   * its presence anywhere means the lockfiles cannot be taken as the install.
   */
  npmrcPaths: string[];
  /**
   * Paths of every `pnpm-workspace.yaml`, `.yarnrc.yml` and `.pnpmfile.cjs` in
   * the (non-excluded) tree: configuration of another package manager.
   */
  packageManagerConfigPaths: string[];
}

/**
 * Pure: the lockfiles of other package managers in a flat git tree (see
 * `FOREIGN_LOCKFILE_NAMES`), with the same vendored/build/fixture exclusion as
 * `selectLockfilePaths`.
 */
export function selectForeignLockfilePaths(entries: TreeEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    const base = entry.path.split('/').pop();
    if (base && FOREIGN_LOCKFILE_NAMES.has(base.toLowerCase())) out.push(entry.path);
  }
  return out;
}

/**
 * Pure: the `.npmrc` files in a flat git tree, with the same vendored/build/
 * fixture exclusion as `selectLockfilePaths`.
 */
export function selectNpmrcPaths(entries: TreeEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    if (entry.path.split('/').pop()?.toLowerCase() === '.npmrc') out.push(entry.path);
  }
  return out;
}

/**
 * Pure: the `pnpm-workspace.yaml`, `.yarnrc.yml` and `.pnpmfile.cjs` files in a
 * flat git tree, with the same vendored/build/fixture exclusion as
 * `selectLockfilePaths`.
 */
export function selectPackageManagerConfigPaths(entries: TreeEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    const base = entry.path.split('/').pop();
    if (base && PACKAGE_MANAGER_CONFIG_NAMES.has(base.toLowerCase())) out.push(entry.path);
  }
  return out;
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

  // `npmDeclarations` resolves an `npm:` alias entry to its real name + range
  // and drops workspace-internal references before the by-name collapse (see
  // the `npm:` alias RESOLUTION paragraph in the docstring above); a
  // non-alias or unparseable-alias entry passes through unchanged.
  for (const decl of npmDeclarations(manifests)) {
    add(decl.name, decl.versionSpec, decl.isDev);
  }

  return [...byName.values()];
}

/**
 * Pure: every `dependencies` / `devDependencies` declaration of every manifest,
 * one entry per declaring manifest and field (NOT deduped by name), with an
 * `npm:` alias resolved to its real name and range exactly as `unionNpmDeps`
 * does, and workspace-internal references (a name that is one of the local
 * manifests' own `name`) left out. Order: per manifest, dependencies, then
 * devDependencies. `unionNpmDeps` is the by-name collapse of this list; the
 * repo-wide CVE chain reads it to see every declared range of a name, not only
 * the one `unionNpmDeps` keeps.
 */
export function npmDeclarations(manifests: ParsedNpmManifest[]): UnionedDep[] {
  const localNames = new Set(
    manifests.map((m) => m.name).filter((n): n is string => Boolean(n)),
  );
  const out: UnionedDep[] = [];
  const push = (name: string, rawSpec: unknown, isDev: boolean) => {
    const spec = String(rawSpec);
    const alias = parseNpmAlias(spec);
    const resolved = alias ? { name: alias.realName, spec: alias.realSpec } : { name, spec };
    if (localNames.has(resolved.name)) return; // workspace-internal reference
    out.push({ name: resolved.name, versionSpec: resolved.spec, isDev });
  };
  for (const m of manifests) {
    for (const [name, spec] of Object.entries(m.dependencies ?? {})) push(name, spec, false);
    for (const [name, spec] of Object.entries(m.devDependencies ?? {})) push(name, spec, true);
  }
  return out;
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
export function parseNpmAlias(spec: string): { realName: string; realSpec: string } | null {
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
): Promise<EcosystemInfo & { observedTreeFacts?: ObservedTreeFacts | null }> {
  const octokit = createGitHubClient(accessToken);

  let refs: ManifestRef[] = [];
  let observedLockfilePaths: { npm: string[]; yarn: string[] } | null = null;
  let observedTreeFacts: ObservedTreeFacts | null = null;
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
    const allRefs = collectManifestRefs(tree);
    refs = allRefs.slice(0, MAX_MANIFESTS);
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
      observedTreeFacts = {
        foreignLockfilePaths: selectForeignLockfilePaths(tree),
        manifestsCapped: allRefs.length > MAX_MANIFESTS,
        npmrcPaths: selectNpmrcPaths(tree),
        packageManagerConfigPaths: selectPackageManagerConfigPaths(tree),
      };
    }
    if (data.truncated || refs.length === 0) needFallback = true;
  } catch (err) {
    // A missing ref or an empty repository is "nothing to walk"; anything else
    // (revoked token, outage) means the tree could not be read, so a monorepo's
    // nested manifests may be missing even if the root probe below works.
    if (!isNothingThere(err)) noteDegraded('GitHub git tree', err);
    else if ((err as { status?: unknown }).status === 404) await confirmWholeRepo(octokit, owner, repo);
    needFallback = true;
  }

  // Fallback: probe the repo root for manifests (legacy behaviour). Merge so a
  // truncated tree that already surfaced some manifests doesn't lose the root.
  if (needFallback) {
    // Any fallback (exception, truncated tree, or a walk that yielded zero
    // manifest refs and is being patched up via the root probe) means the
    // observed set does not describe the tree the fetched manifests came
    // from - it must not be used to filter candidates.
    observedLockfilePaths = null;
    observedTreeFacts = null;
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
    observedTreeFacts,
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
        } catch (err) {
          // Missing (404) is skipped as "not there". Unreadable for any other
          // reason is skipped too so one bad path can't sink the scan, but it
          // is reported so the scanner does not count the run as fully read.
          if (!isNothingThere(err)) noteDegraded('GitHub file read', err);
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
// "Usable manifest floor" (task 7fc55e6f): `collectDeps`
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
//
// Narrow override (on top of this resolution, which stays the baseline): for repos made of
// separate projects that each carry their own package-lock.json, a name that
// resolves to different versions in different projects is ambiguous repo-wide
// and used to fall to a manifest floor that no project installs. The scan now
// also queries what each manifest's own lockfile installs, and removes the
// baseline entry only when no package-lock.json the scan reads installs it; see
// `resolveNarrowNpm` for the exact rule. The baseline alone remains the
// behaviour for npm workspaces (any `workspaces` key), for repos with a
// yarn.lock, pnpm-lock.yaml, bun lockfile or npm-shrinkwrap.json, for repos
// whose git tree or manifest list could not be read completely, and for every
// dependency whose manifest, lockfile or declaration does not meet the narrow
// conditions.

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
  /**
   * name -> EVERY distinct concrete version any lockfile entry recorded for
   * the name (the single `resolved` version, or all the versions behind an
   * `ambiguous` entry, nested copies included for lockfileVersion 2/3 and
   * yarn.lock; a v1 lockfile is read top-level only). Optional so a hand-built
   * `{ resolved, ambiguous }` stays valid; when absent a caller falls back to
   * the `resolved` and `ambiguous` values. The repo-wide CVE chain queries
   * these for a name that a non-range spec (`latest`, a tag, `*`) declares.
   */
  observed?: Map<string, Set<string>>;
}

/** Every version the lockfile resolutions know for `name` (see `observed`). */
export function lockfileVersionsOf(resolutions: LockfileResolutions, name: string): string[] {
  const out = new Set<string>(resolutions.observed?.get(name) ?? []);
  const resolved = resolutions.resolved.get(name);
  if (resolved !== undefined) out.add(resolved);
  const ambiguous = resolutions.ambiguous.get(name);
  if (ambiguous !== undefined) out.add(ambiguous);
  return [...out].filter((v) => /\d/.test(v));
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
  const observed = new Map<string, Set<string>>();

  const record = (name: string, version: string): void => {
    if (!/\d/.test(version)) return; // skip non-concrete placeholders
    const seenVersions = observed.get(name);
    if (seenVersions) seenVersions.add(version);
    else observed.set(name, new Set([version]));
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

  return { record, result: () => ({ resolved, ambiguous, observed }) };
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
 * This merged, name-keyed map is the repo-wide baseline. The narrow override
 * (`resolveNarrowNpm`) adds per-manifest answers on top of it for the
 * separate-projects shape and leaves this map's semantics untouched.
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
 * The `package-lock.json` paths `fetchNpmLockfileResolutions` reads: the
 * candidates from `discoverLockfilePaths`, narrowed to the observed set when
 * one is known (case-insensitive, like the fetcher always did).
 *
 * Pure function, exported for testing.
 */
export function npmLockfileFetchPaths(
  manifestPaths: string[],
  observedLockfilePaths?: string[] | null,
): string[] {
  const candidatePaths = discoverLockfilePaths(manifestPaths);
  const observedSet =
    observedLockfilePaths == null ? null : new Set(observedLockfilePaths.map((p) => p.toLowerCase()));
  return observedSet == null ? candidatePaths : candidatePaths.filter((p) => observedSet.has(p.toLowerCase()));
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
  fetchedSink?: FetchedManifest[],
): Promise<LockfileResolutions> {
  const lockPaths = npmLockfileFetchPaths(manifestPaths, observedLockfilePaths);
  const fetched = await fetchManifestContents(octokit, owner, repo, lockPaths);
  // The raw files, for the narrow override (`resolveNarrowNpm`); same reads,
  // no extra request.
  fetchedSink?.push(...fetched);
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

  // Every version any input observed for a name, kept whole (the `ambiguous`
  // map above keeps only the lowest). The inputs' `resolved` and `ambiguous`
  // values count as observed even when an input carries no `observed` map.
  const observed = merged.observed ?? new Map<string, Set<string>>();
  const observe = (name: string, version: string): void => {
    if (!/\d/.test(version)) return;
    const versions = observed.get(name);
    if (versions) versions.add(version);
    else observed.set(name, new Set([version]));
  };
  for (const input of results) {
    for (const [name, versions] of input.observed ?? []) {
      for (const version of versions) observe(name, version);
    }
    for (const [name, version] of input.resolved) observe(name, version);
    for (const [name, version] of input.ambiguous) observe(name, version);
  }
  merged.observed = observed;

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
  fetchedSink?: FetchedManifest[],
): Promise<ParsedNpmManifest[]> {
  const out: ParsedNpmManifest[] = [];
  const fetched = await fetchManifestContents(octokit, owner, repo, paths);
  // The raw files with their paths, for the narrow override
  // (`resolveNarrowNpm`); same reads, no extra request.
  fetchedSink?.push(...fetched);
  for (const { content } of fetched) {
    try {
      out.push(JSON.parse(content) as ParsedNpmManifest);
    } catch {
      // Malformed JSON — skip it.
    }
  }
  return out;
}

// ---- narrow lockfile override ------------------------------------------------
//
// The repo-wide chain (`mergeLockfileResolutions`, then the manifest floor,
// then `ambiguous`) stays the baseline for every dependency. On top of it, for
// two well-understood repo shapes, the scan also asks what the lockfile that
// installs a manifest holds for it. The first shape: several separate
// projects, each with its own package.json and package-lock.json (`frontend/`
// and `backend/`). The second: an npm workspace, a root package.json with a
// `workspaces` key whose own package-lock.json installs its member packages.
// When a name resolves to different versions in different projects (or in
// different places of one lockfile) it drops out of `resolved` and is queried
// at a manifest floor that nothing may install.
//
// Workspace membership comes from the root's lockfile, never from the
// `workspaces` patterns, which are not evaluated (`provenWorkspaceFolders`).
// The lockfile (lockfileVersion 2 or 3) must record the root's `workspaces`
// value unchanged in its root entry, as npm writes it (a lockfile written for
// other patterns is stale). A manifest below the root is a member when the
// lockfile has an entry for its folder and a `node_modules/<its name>` entry
// with `link: true` that resolves to exactly that folder. Every `link` entry
// of the lockfile must resolve to such a member folder, so no linked package
// escapes the check. A member resolves a dependency from its own
// `<folder>/node_modules/<name>` entry, else from the root's
// `node_modules/<name>` (`workspaceMemberLockKey`); an entry under a folder
// between the two is not followed.
//
// A workspace is narrowed only when every dependency spec the scan reads is a
// registry range, version, dist-tag or `npm:` alias (`isRegistrySpec`,
// `repoHasOnlyRegistrySpecs`): the `dependencies`, `devDependencies`,
// `optionalDependencies` and `peerDependencies` and every value inside
// `overrides` (and the spec after the package name in an `overrides` key,
// `t@file:tools/t`) of every read package.json, and the same maps of every
// entry of every workspace root's own lockfile. A spec of any other kind
// (`file:`, `link:`, `workspace:`, a path in any spelling, git, a URL, a
// tarball) can make a folder of the repository a project npm installs on its
// own, with the same lockfile shape as a member, so one such spec anywhere
// leaves every workspace root of the repository unproven. The rule lists what
// is accepted; nothing tries to work out which folder a spec names. The specs
// that miss the cheap forms (a version, a simple `^` / `~` range, a dist-tag)
// share one character budget over the whole pass (`MAX_SLOW_SPEC_CHARS`);
// beyond it no root is proven.
//
// This does not close the class of a folder that is no member. Residual: a
// folder the root lockfile still links after it left the `workspaces`
// patterns, or after a `file:` spec became a registry range, counts as a
// member. `npm ci` at the root installs it from the root lockfile, but
// `npm install` inside that folder installs it on its own without a lockfile.
// npm itself keeps such a link in a lockfile it rewrites.
//
// What a removal guarantees: no under-reporting for an install that honours the
// lockfiles, that is `npm ci`, or `npm install` on a lockfile that has no
// missing or invalid edge. Under `npm ci` npm refuses a lockfile that differs
// from the ideal tree, so the lockfile is the install. Out of that guarantee,
// and so residuals that can still install a removed floor: `npm install` on a
// lockfile whose transitive edges are inconsistent (npm re-resolves them from
// the registry; this scan notices an edge to a name without any entry, not an
// edge the lockfile does not satisfy at the location npm resolves it from: out
// of range, or present only on another branch), a git or `file:` dependency
// changed without updating the lockfile, the contents of a bundling optional
// package that the lockfile was written without unpacking (on another
// platform: its bundled dependencies' own dependencies are not in the
// lockfile), command line flags, a user or global npmrc, the environment and
// the state of the registry.
//
//   - ADDITIONS. A (manifest, dependency) pair is narrow-resolved when
//     `narrowVersion` finds the dependency in the manifest's own-directory
//     `package-lock.json` (lockfileVersion 2/3, top-level key
//     `node_modules/<name>` only, never an ancestor's lockfile) and the manifest
//     is narrow for it (the declaration rules below). Declarations in `dependencies`,
//     `devDependencies`, `optionalDependencies` and `peerDependencies` all add.
//     In a workspace (the root and its members) only `dependencies` and
//     `devDependencies` declarations are narrow, the root's lockfile must prove
//     the membership (above), and a member is narrow for a name only when the
//     root's `node_modules/<name>` is what it resolves: a copy under its own
//     folder or a folder between keeps the floor, so members that install
//     different versions of a name keep it as well.
//   - REMOVAL. The baseline entry of a name is removed only when everything the
//     scan reads is positively accounted for. `narrowDropSafe` holds when ALL of
//     these hold:
//       * the tree was read completely (not truncated, manifest list not cut);
//       * the tree has no other package manager's lockfile (yarn.lock,
//         pnpm-lock.yaml, bun.lock, bun.lockb, npm-shrinkwrap.json, deno.lock)
//         and none of `.npmrc`, `pnpm-workspace.yaml`, `.yarnrc.yml`,
//         `.pnpmfile.cjs`, and no manifest has a `packageManager` or a
//         `devEngines.packageManager` field (each can change what is installed
//         without the package-lock.json saying so);
//       * every manifest the scan reads is locked. A manifest below a
//         `workspaces` root is locked only as a proven member: the root's
//         lockfile lists each of its declarations at the entry the member
//         resolves it from, with the same range rules as below, and the member
//         has no `overrides` (npm ignores a member's overrides; this scan does
//         not vouch for them). A manifest below a root that does not prove it,
//         below two roots, or below an unread package.json is not locked. Any
//         other manifest: its own-directory
//         package-lock.json was fetched and parsed, has a known shape
//         (lockfileVersion 2 or 3 with a `packages` map), lists every key of the manifest's `dependencies`, `devDependencies`,
//         `optionalDependencies` and `peerDependencies` (a peer that
//         `peerDependenciesMeta` marks `optional: true` excepted) as a
//         top-level entry whose version satisfies the declared range (a spec
//         that is not a plain semver range only needs the entry to exist), and
//         reflects the manifest's `overrides`: every entry of an overridden
//         name satisfies a plain string override, and an override that is not a
//         plain string (a nested object, a `$` reference, a number, a key with a
//         version selector, a spec that is no semver range) cannot be vouched
//         for. Ranges are judged as npm judges a lockfile: loose parsing, no
//         `includePrerelease`, so a prerelease satisfies only a range that
//         names a prerelease of the same release. A missing, stale or
//         unreadable lockfile means the project installs fresh, which nothing
//         here can see. Local package names are not exempt: only the same names
//         the baseline leaves out would qualify, and a stale lockfile that lacks
//         one still installs its dependencies fresh. In a workspace a
//         `link: true` entry satisfies a declared range only when it resolves
//         to a proven member whose package.json `version` the range admits and
//         the lockfile's entry for that folder has the same version (npm reads
//         a linked member's version from its package.json);
//       * every manifest declaring the name (`dependencies`, `devDependencies`,
//         `optionalDependencies`, `peerDependencies`, `bundleDependencies`) is
//         narrow for it;
//       * the baseline version is installed by no fetched lockfile at any
//         install path. This is answered from an index built once over all
//         fetched lockfiles, under one node budget. Every lockfile must have a
//         known shape (a lockfileVersion 1 lockfile has none: npm takes each
//         package's dependency edges from the registry, not from the
//         lockfile, so one anywhere makes every name unprovable) and every entry that names
//         a package must carry a semver version (an `npm:` alias is resolved
//         first); an entry that does not (a git or tarball version, a `file:`
//         version, no version, not an object) makes its name "unknown", and an
//         unknown name is never provably uninstalled. The edges of the
//         `packages` entries are read too: `dependencies`, `optionalDependencies`
//         and `peerDependencies` (a peer the entry itself marks optional in its
//         `peerDependenciesMeta` excepted), of every entry including the root
//         entry and workspace folders. An edge to a name the same lockfile has
//         no entry for by key (an alias key counts as the key it is) makes the
//         lockfile unusable and every name unprovable: `npm install` resolves
//         such an edge from the registry (a lockfile written with
//         `--legacy-peer-deps`, a damaged or hand-edited one). Two exemptions:
//         entries marked `inBundle` (their edges are inside the package), and
//         a name the entry itself lists in `bundleDependencies` or
//         `bundledDependencies` (npm takes it from the tarball): that name only
//         becomes unknown. The legacy `dependencies` mirror of a version 2
//         lockfile is scanned for installed versions only, since npm reads the
//         `packages` map. An exhausted budget (entries and edges count) makes
//         every name unprovable.
//
// "Complete tree" and "no other package manager's lockfile" gate the whole
// override, additions included: without them there is no narrow resolution and
// the result is the baseline. The other conditions gate removals only, since an
// addition never removes anything. Optional, peer and bundled declarations block
// removals; only a bundled one never adds. Nothing else removes or replaces an entry. A
// manifest with a lockfileVersion 1 lockfile is not narrow and keeps the
// baseline chain. No pattern is built from repository content: `workspaces` is
// tested for presence and compared, as a whole value, with the copy in the
// root's lockfile, never evaluated. Whatever a check cannot establish (a read or parse error, an
// unknown shape, an exhausted budget) keeps the baseline entry: under-reporting
// is worse than over-reporting. "Installed nowhere" means in no package-lock.json
// the scan reads; vendored, build and fixture directories are not read. A
// workspace member in one of them leaves a link in the root lockfile that no
// read manifest proves, so that root proves nothing and the whole workspace
// keeps every baseline entry (its lockfile entries still count as installed).
// A workspace manifest the root lockfile does not prove (a lockfileVersion 1, missing or unreadable root
// lockfile, a `workspaces` value the lockfile does not record, a member it does
// not list, a member that is a workspace root itself, a dependency spec other
// than a registry spec anywhere in the read manifests or in a workspace
// root's lockfile, a member folder nested deeper than 16 folders or longer
// than 256 characters) adds nothing, and one below the root
// keeps every baseline entry of the repository. Repos with another package
// manager's lockfile and repos whose tree could not be read completely keep
// the baseline result.

/** What `resolveNarrowNpm` reads. The raw files are the ones the fetchers read anyway. */
export interface NarrowNpmInputs {
  /** The package.json paths the scan reads (`fetchNpmManifests`' `paths`). */
  manifestPaths: string[];
  /** The package.json files that were read (path + raw content). */
  manifestFiles: FetchedManifest[];
  /** The package-lock.json files that were read (path + raw content). */
  lockfileFiles: FetchedManifest[];
  /** `EcosystemInfo.observedLockfilePaths`; null when the tree walk was incomplete. */
  observedLockfilePaths: { npm: string[]; yarn: string[] } | null | undefined;
  /** `detectEcosystem`'s `observedTreeFacts`; null/undefined when the tree walk was incomplete. */
  observedTreeFacts: ObservedTreeFacts | null | undefined;
}

export interface NarrowNpmResolution {
  /** Every narrow-resolved (name, version), deduped by (name, version). */
  additions: Array<{ name: string; version: string }>;
  /** `narrowDropSafe`: may the baseline entry (name, baseVersion) be removed? */
  dropSafe: (name: string, baseVersion: string) => boolean;
}

const NO_NARROW_RESOLUTION: NarrowNpmResolution = { additions: [], dropSafe: () => false };

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// An own property only: `JSON.parse` can create a key called `__proto__`, and a
// plain lookup of an absent `__proto__` would answer with `Object.prototype`.
function hasOwn(o: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function ownValue(o: JsonObject, key: string): unknown {
  return hasOwn(o, key) ? o[key] : undefined;
}

function parseJsonObject(content: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function ownLockfilePath(dir: string): string {
  return dir ? `${dir}/package-lock.json` : 'package-lock.json';
}

// Is `ancestor` the directory `dir` itself or one of its parents? '' is the repo root.
function isSelfOrAncestorDir(ancestor: string, dir: string): boolean {
  return ancestor === '' || dir === ancestor || dir.startsWith(ancestor + '/');
}

// Lockfile validity the way npm judges it: a version satisfies a spec in loose
// mode and without `includePrerelease` (a prerelease version only satisfies a
// range that itself names a prerelease of the same release).
function satisfiesLikeNpm(version: string, range: string): boolean {
  return semver.satisfies(version, range, true);
}

function isPlainSemverRange(spec: string): boolean {
  return semver.validRange(spec, true) !== null;
}

interface NarrowDeclaration {
  /** The manifest field the declaration comes from. */
  field: string;
  /** The key the manifest declares the dependency under. */
  key: string;
  spec: string;
  /** The spec starts with `npm:` (an alias form, parseable or not). */
  aliasForm: boolean;
  /** The name `unionNpmDeps` queries it under: the alias target, else the key. */
  realName: string;
  /**
   * May this declaration produce an addition? Every one with a version range does
   * (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`;
   * an optional peer only when its own lockfile lists it). A bundled name carries
   * no range, blocks removals and never adds.
   */
  addable: boolean;
  /**
   * Must the manifest's own lockfile list the key at the top level? Yes for
   * `dependencies`, `devDependencies`, `optionalDependencies` and
   * `peerDependencies`, except a peer that `peerDependenciesMeta` marks
   * `optional: true` (npm does not install it); no for a bundled name.
   */
  lockRequired: boolean;
}

interface NarrowManifest {
  path: string;
  dir: string;
  data: JsonObject;
  declarations: NarrowDeclaration[];
  /**
   * Top-level `overrides` entries with a plain string spec (a semver range),
   * by package name. Only meaningful when `overridesPlain` holds.
   */
  overrides: Map<string, string>;
  /**
   * Every `overrides` entry is a package name with a plain string spec. A
   * non-string value (a nested object, a number), a `$` reference, a key with a
   * version selector or a spec that is not a semver range makes the manifest's
   * lockfile unable to vouch for what the overrides install.
   */
  overridesPlain: boolean;
}

// The fields that declare a package with a version range (`bundleDependencies` has none).
const DECLARING_DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

// A manifest whose dependency maps have an unexpected shape (not an object, a
// spec that is not a string) counts as unread: it could declare anything.
function readNarrowManifest(path: string, content: string): NarrowManifest | null {
  const data = parseJsonObject(content);
  if (!data) return null;
  const declarations: NarrowDeclaration[] = [];
  // `peerDependenciesMeta` of an unexpected shape makes the manifest unread.
  const rawPeerMeta = data.peerDependenciesMeta;
  if (rawPeerMeta !== undefined && !isPlainObject(rawPeerMeta)) return null;
  const peerMeta: JsonObject | undefined = rawPeerMeta;
  // `npm ci` installs a root project's dependencies, devDependencies and
  // optionalDependencies, and its peerDependencies (an optional peer only when
  // something else requires it), so each of them adds a version when narrow.
  // The baseline queries only the first two.
  for (const field of DECLARING_DEP_FIELDS) {
    const map = data[field];
    if (map === undefined) continue;
    if (!isPlainObject(map)) return null;
    for (const [key, spec] of Object.entries(map)) {
      if (typeof spec !== 'string') return null;
      const alias = parseNpmAlias(spec);
      declarations.push({
        field,
        key,
        spec,
        aliasForm: spec.trim().startsWith('npm:'),
        realName: alias ? alias.realName : key,
        addable: true,
        // npm 7 and later install peers, unless they are marked optional.
        lockRequired: !(field === 'peerDependencies' && peerIsOptional(peerMeta, key)),
      });
    }
  }
  // `bundleDependencies` / `bundledDependencies`: a list of names (or a boolean
  // that bundles the `dependencies`, which are declared above anyway). Any other
  // shape makes the manifest unread.
  for (const field of ['bundleDependencies', 'bundledDependencies'] as const) {
    const list = data[field];
    if (list === undefined || typeof list === 'boolean') continue;
    if (!Array.isArray(list)) return null;
    for (const name of list) {
      if (typeof name !== 'string') return null;
      // A bundled name carries no range: it is matched against `*`, which (as for
      // npm) a prerelease version does not satisfy.
      declarations.push({
        field,
        key: name,
        spec: '*',
        aliasForm: false,
        realName: name,
        addable: false,
        lockRequired: false,
      });
    }
  }
  const { overrides, plain: overridesPlain } = readOverrides(data.overrides);
  return { path, dir: dirOf(path), data, declarations, overrides, overridesPlain };
}

// Is the peer `key` marked `optional: true` in `peerDependenciesMeta`?
function peerIsOptional(meta: JsonObject | undefined, key: string): boolean {
  if (!meta) return false;
  const entry = ownValue(meta, key);
  return isPlainObject(entry) && entry.optional === true;
}

// The `overrides` of a manifest. Plain means: every top-level entry is a package
// name (no version selector, not the `.` self key) with a string spec that is a
// semver range (so not a `$` reference, an alias, a URL, a tag or a nested
// object). Anything else, or an `overrides` that is not an object, is not plain.
function readOverrides(raw: unknown): { overrides: Map<string, string>; plain: boolean } {
  const overrides = new Map<string, string>();
  if (raw === undefined) return { overrides, plain: true };
  if (!isPlainObject(raw)) return { overrides, plain: false };
  for (const [key, value] of Object.entries(raw)) {
    if (key === '.' || key.indexOf('@', 1) !== -1) return { overrides, plain: false };
    if (typeof value !== 'string' || value.trim() === '' || !isPlainSemverRange(value)) {
      return { overrides, plain: false };
    }
    overrides.set(key, value);
  }
  return { overrides, plain: true };
}

// Does the manifest pin a package manager? `packageManager` (corepack) and
// `devEngines.packageManager` both do; a `devEngines` that is not an object
// cannot be read, so it counts as pinning.
function pinsPackageManager(data: JsonObject): boolean {
  if (hasOwn(data, 'packageManager')) return true;
  if (!hasOwn(data, 'devEngines')) return false;
  const devEngines = data.devEngines;
  return !isPlainObject(devEngines) || hasOwn(devEngines, 'packageManager');
}

interface NarrowLockfile {
  data: JsonObject;
  /** The `packages` map of a lockfileVersion 2 or 3 lockfile. */
  packages: JsonObject;
}

// A lockfile this scan can prove things from: lockfileVersion 2 or 3 with a
// `packages` object. Anything else is null and proves nothing about what
// installs. That includes lockfileVersion 1: npm takes each package's
// dependency edges from the registry, not from a v1 lockfile, so a v1 lockfile
// does not show everything that is installed.
function readNarrowLockfile(content: string): NarrowLockfile | null {
  const data = parseJsonObject(content);
  if (!data) return null;
  const version = data.lockfileVersion;
  const packages = data.packages;
  if ((version !== 2 && version !== 3) || !isPlainObject(packages)) return null;
  return { data, packages };
}

// Budget for the one pass over all fetched lockfiles: lockfile entries visited
// in total, not per lockfile. A repository beyond it is not trusted to have been
// indexed completely, so nothing is provably installed nowhere. The pass over
// the dependency specs a workspace proof reads (`repoHasOnlyRegistrySpecs`)
// has a budget of the same size, of specs and entries.
export const MAX_LOCK_INDEX_NODES = 1_000_000;

// Budget for the characters of the specs that miss the cheap forms (a version or
// a simple `^` / `~` range, a dist-tag) and so go through `semver.validRange`,
// counted over the whole pass of `repoHasOnlyRegistrySpecs`. `validRange` costs
// up to about 0.5 microseconds per character on the slowest shapes measured
// (long `||` chains), so the budget keeps the pass to about a second. A real
// monorepo stays far below it: only its compound specs (`>=1 <3`,
// `^16 || ^17`) go through `validRange`. Beyond the budget the pass fails
// closed: no workspace root is proven.
export const MAX_SLOW_SPEC_CHARS = 2_000_000;

// The characters of slow-path specs a pass may still read (see above).
export interface SlowSpecBudget {
  remaining: number;
}

// What the fetched lockfiles install, at any install path. `versions` holds, per
// name, both the raw version string and its semver-normalised form (which drops
// build metadata), so a lookup counts unequal strings that are semver-equal as
// the same version and errs towards keeping the baseline entry. `unknown` holds
// the names some entry installs at a version that could not be read as semver.
interface InstalledIndex {
  versions: Map<string, Set<string>>;
  unknown: Set<string>;
}

const NODE_MODULES = 'node_modules/';

// The edge fields of a lockfile entry that npm installs from.
const EDGE_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

// The names an entry lists in its own `bundleDependencies` / `bundledDependencies`
// (an array of names; any other shape lists none). An item that is not a string
// never equals an edge key, so it needs no filtering.
function bundledNamesOf(entry: JsonObject): Set<unknown> {
  const names = new Set<unknown>();
  for (const field of ['bundleDependencies', 'bundledDependencies'] as const) {
    const list = entry[field];
    if (!Array.isArray(list)) continue;
    for (const name of list) names.add(name);
  }
  return names;
}

// The package name a `packages` key installs under: what follows its last
// `node_modules/`. undefined for a key without one (a workspace package folder).
function nameFromPackagesKey(key: string): string | undefined {
  const i = key.lastIndexOf(NODE_MODULES);
  return i === -1 ? undefined : key.slice(i + NODE_MODULES.length);
}

// ---- npm workspaces: membership from the root lockfile ----------------------

// A `workspaces` value npm reads: a non-empty array of strings, or an object
// whose `packages` is one. npm refuses any other shape, and writes an empty one
// into no lockfile, so nothing else can be recorded.
function hasWorkspacePatterns(value: unknown): boolean {
  const list = Array.isArray(value) ? value : isPlainObject(value) ? ownValue(value, 'packages') : undefined;
  return Array.isArray(list) && list.length > 0 && list.every((p) => typeof p === 'string');
}

// Bounds on a member folder. `workspaceMemberLockKey` builds and looks up one
// key per parent folder for every declaration of a member, so its cost grows
// with the declarations of a manifest (up to its 1 MB size) times the folder's
// depth times its length; a folder past either bound is never a proven member
// (fail closed: the workspace keeps the floor), which keeps that cost
// independent of how deep a repository nests. Real monorepos nest members two
// to five folders deep with short names; 16 segments and 256 characters leave
// room for any layout a team would keep, and cap the work at a few hundred
// million character comparisons for the largest manifest.
export const MAX_MEMBER_FOLDER_SEGMENTS = 16;
export const MAX_MEMBER_FOLDER_CHARS = 256;

// A folder path relative to a workspace root, as npm writes it into a
// lockfile: `/`-separated segments, none empty, `.`, `..` or `node_modules`,
// and no backslash, at most `MAX_MEMBER_FOLDER_SEGMENTS` segments and
// `MAX_MEMBER_FOLDER_CHARS` characters. Anything else is never a proven member
// folder.
function isMemberFolder(folder: string): boolean {
  if (folder.length > MAX_MEMBER_FOLDER_CHARS || folder.includes('\\')) return false;
  const segments = folder.split('/');
  return (
    segments.length <= MAX_MEMBER_FOLDER_SEGMENTS &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== 'node_modules')
  );
}

// ---- dependency specs: registry specs only ----------------------------------

// The fields of a package.json or lockfile entry that map names to specs.
const SPEC_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

// npm reads a spec with this ending as a tarball file before it asks the
// registry, whatever the rest looks like (`1.0.0-x.tgz`, `latest.tar`). The
// `.` inside `tar.gz` matches any character, so this catches a little more
// than npm does.
const TARBALL_SUFFIX = /[.](?:tgz|tar.gz|tar)$/i;
// The most common spec, a version or its `^` / `~` range, without a call into
// `semver`: numbers without leading zeros and of at most 15 digits, which
// `semver.validRange` accepts too.
const PLAIN_VERSION_RANGE = /^[\^~]?(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})$/;
// A dist-tag: not empty, `A-Z a-z 0-9 . _ -` only, not starting with a dot.
const DIST_TAG = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
// The target of an `npm:` alias: a package name, optionally scoped.
const ALIAS_TARGET_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A version, range or dist-tag the registry resolves: no tarball ending, and a
// plain version range, a dist-tag or a range `semver.validRange` accepts in
// strict mode. Strict, because loose mode drops every comparator it cannot
// read: it accepts `^1.0.0 || ./x` and `1.0.0 ../tools/t`, which npm reads as
// folders. A spec that misses the two cheap forms is charged to `budget` (its
// length) before `validRange` reads it; one the budget cannot cover is not
// accepted (fail closed), unread.
function isRegistryRange(spec: string, budget?: SlowSpecBudget): boolean {
  if (TARBALL_SUFFIX.test(spec.trim())) return false;
  if (PLAIN_VERSION_RANGE.test(spec) || DIST_TAG.test(spec)) return true;
  if (budget) {
    budget.remaining -= spec.length;
    if (budget.remaining < 0) return false;
  }
  return semver.validRange(spec) !== null;
}

/**
 * Pure: is this dependency spec one that npm resolves from the registry, so
 * that it cannot make a folder of the repository a project of its own? Only
 * these forms are:
 *
 *   - a version or range (`semver.validRange` in strict mode);
 *   - a dist-tag (`A-Z a-z 0-9 . _ -`, not empty, not starting with a dot);
 *   - `npm:<name>@<version, range or dist-tag>`.
 *
 * None of them may end in `.tgz`, `.tar` or `.tar.gz`. Everything else is
 * not: a `file:` or `link:` spec, a path in any spelling (`tools/t`,
 * `tools/t/`, `./x`, `a/b/c`, `@s/x`), a git, GitHub or URL spec, a tarball, a
 * `~` or absolute path, a Windows path, a `$` reference, a `workspace:` spec
 * (it names a package of the repository, not one of the registry), a value
 * that is not a string.
 *
 * With a `budget`, a spec that misses the cheap forms (a version or simple
 * `^` / `~` range, a dist-tag) is charged to it by length, and a spec the
 * budget cannot cover is not a registry spec.
 */
export function isRegistrySpec(spec: unknown, budget?: SlowSpecBudget): boolean {
  if (typeof spec !== 'string') return false;
  if (spec.startsWith('npm:')) {
    const target = spec.slice('npm:'.length);
    const at = target.indexOf('@', 1);
    return at > 0 && ALIAS_TARGET_NAME.test(target.slice(0, at)) && isRegistryRange(target.slice(at + 1), budget);
  }
  return isRegistryRange(spec, budget);
}

/**
 * Pure: how many dependency specs does one package.json or lockfile entry
 * hold, when every one is a registry spec (`isRegistrySpec`)? Null when one is
 * not. Read: the four dependency maps and every value inside `overrides`, at
 * any depth (inside objects and arrays); each map value and each `overrides`
 * value counts once. A map that is not an object, or an `overrides` value that
 * is neither a string, an object nor an array, also answers null. An
 * `overrides` key can carry a spec too (`t@file:tools/t` overrides `t` where
 * its version is `file:tools/t`): the part after the `@` that follows the
 * package name (an `@` after the first character) is a spec like any other and
 * must be a registry spec; it adds nothing to the count. `budget` is charged
 * for every slow-path spec, see `isRegistrySpec`.
 */
export function registrySpecCount(data: Record<string, unknown>, budget?: SlowSpecBudget): number | null {
  let count = 0;
  for (const field of SPEC_FIELDS) {
    const map = ownValue(data, field);
    if (map === undefined) continue;
    if (!isPlainObject(map)) return null;
    for (const spec of Object.values(map)) {
      if (!isRegistrySpec(spec, budget)) return null;
      count++;
    }
  }
  const pending: unknown[] = hasOwn(data, 'overrides') ? [data.overrides] : [];
  while (pending.length > 0) {
    const value = pending.pop();
    count++;
    if (typeof value === 'string') {
      if (!isRegistrySpec(value, budget)) return null;
    } else if (isPlainObject(value) || Array.isArray(value)) {
      if (!Array.isArray(value)) {
        for (const key of Object.keys(value)) {
          const at = key.indexOf('@', 1);
          if (at > 0 && !isRegistrySpec(key.slice(at + 1), budget)) return null;
        }
      }
      for (const inner of Object.values(value)) pending.push(inner);
    } else return null;
  }
  return count;
}

/**
 * Pure: can any workspace root of the repository be proven? Only when every
 * dependency spec the scan reads is a registry spec (`registrySpecCount`): the
 * specs of every read package.json (`manifests`) and of every entry of every
 * workspace root's own lockfile (`rootLockPackages`, the `packages` maps).
 * Any other spec may install a folder of the repository as a project of its
 * own, which npm records with the same lockfile shape as a workspace member,
 * so one anywhere leaves every workspace root unproven. One pass, under a
 * budget of `maxNodes` (specs and lockfile entries count, the same budget as
 * the lockfile index) and a budget of `maxSlowChars` characters for the specs
 * that miss the cheap forms and so go through `semver` (`MAX_SLOW_SPEC_CHARS`,
 * counted over the whole pass): a repository beyond either is not read to the
 * end, so no root is proven.
 */
export function repoHasOnlyRegistrySpecs(
  manifests: Iterable<Record<string, unknown>>,
  rootLockPackages: Iterable<Record<string, unknown>>,
  maxNodes: number = MAX_LOCK_INDEX_NODES,
  maxSlowChars: number = MAX_SLOW_SPEC_CHARS,
): boolean {
  let visited = 0;
  const budget: SlowSpecBudget = { remaining: maxSlowChars };
  const read = (data: Record<string, unknown>): boolean => {
    const count = registrySpecCount(data, budget);
    if (count === null) return false;
    visited += count;
    return visited <= maxNodes;
  };
  for (const data of manifests) if (!read(data)) return false;
  for (const packages of rootLockPackages) {
    for (const entry of Object.values(packages)) {
      if (++visited > maxNodes) return false;
      if (isPlainObject(entry) && !read(entry)) return false;
    }
  }
  return true;
}

// A package name that addresses exactly one `node_modules/<name>` entry: one
// segment not starting with `@`, or `@scope/` and one segment; no segment
// empty or starting with a dot, none `node_modules`, no backslash.
function isLinkablePackageName(name: unknown): name is string {
  if (typeof name !== 'string' || name.includes('\\')) return false;
  const segment = (s: string) => s !== '' && !s.startsWith('.') && s.toLowerCase() !== 'node_modules';
  const parts = name.split('/');
  if (parts.length === 1) return segment(parts[0]) && !parts[0].startsWith('@');
  return parts.length === 2 && parts[0].startsWith('@') && segment(parts[0].slice(1)) && segment(parts[1]);
}

// Does the lockfile link `node_modules/<name>` to the package folder `folder`?
// The folder has an entry of its own (not a link, not extraneous, its `name`, if
// written, equal to `name`), and `node_modules/<name>` is a `link: true` entry,
// not extraneous, whose `resolved` is exactly `folder` (npm writes it relative
// and with `/`).
function lockfileLinksFolder(packages: JsonObject, folder: string, name: unknown): boolean {
  if (!isMemberFolder(folder) || !isLinkablePackageName(name)) return false;
  const target = ownValue(packages, folder);
  if (!isPlainObject(target) || target.link !== undefined || target.extraneous) return false;
  if (target.name !== undefined && target.name !== name) return false;
  const link = ownValue(packages, `${NODE_MODULES}${name}`);
  return isPlainObject(link) && link.link === true && !link.extraneous && link.resolved === folder;
}

/**
 * Pure: which candidate manifests below a workspace root does the root's own
 * lockfile prove to be members? `rootWorkspaces` is the root package.json's
 * `workspaces` value, `rootLock` its parsed package-lock.json, and each
 * candidate is a package.json below the root (its folder relative to the root,
 * its `name`). Returns the proven folders, or null when the lockfile proves
 * nothing at all:
 *
 *   - the lockfile is lockfileVersion 2 or 3 with a `packages` map and a root
 *     entry `""`;
 *   - `rootWorkspaces` is a shape npm reads (a non-empty array of strings, or
 *     `{ packages: [...] }`) and the root entry's `workspaces` is the same value
 *     (compared as JSON text): npm copies it there when it writes the
 *     lockfile, so a lockfile written for other patterns is stale;
 *   - every entry with a `link` value is `link: true` and resolves to a proven
 *     folder, so no linked package is left unread (a link outside the root,
 *     to a folder whose package.json the scan did not read, or to the root);
 *   - at most `MAX_LOCK_INDEX_NODES` entries.
 *
 * A candidate is proven when the lockfile has an entry for its folder and
 * links `node_modules/<its name>` to exactly that folder (`lockfileLinksFolder`).
 * The same lockfile shape records a folder that a `file:` or `link:` spec
 * installs as a project of its own, so the caller asks this only when every
 * spec the scan reads is a registry spec (`repoHasOnlyRegistrySpecs`). That
 * does not make a proven folder a member: a folder the root lockfile still
 * links after it left the `workspaces` patterns, or after a `file:` spec became
 * a registry range, is proven all the same. `npm ci` at the root installs it
 * from the root lockfile, but `npm install` inside that folder installs it on its
 * own without a lockfile. The patterns are never evaluated and nothing is
 * built from them.
 */
export function provenWorkspaceFolders(
  rootWorkspaces: unknown,
  rootLock: unknown,
  candidates: ReadonlyArray<{ folder: string; name: unknown }>,
): Set<string> | null {
  if (!isPlainObject(rootLock)) return null;
  const version = rootLock.lockfileVersion;
  const packages = rootLock.packages;
  if ((version !== 2 && version !== 3) || !isPlainObject(packages)) return null;
  const rootEntry = ownValue(packages, '');
  if (!isPlainObject(rootEntry)) return null;
  if (!hasWorkspacePatterns(rootWorkspaces)) return null;
  if (JSON.stringify(ownValue(rootEntry, 'workspaces')) !== JSON.stringify(rootWorkspaces)) return null;
  const proven = new Set<string>();
  for (const { folder, name } of candidates) {
    if (lockfileLinksFolder(packages, folder, name)) proven.add(folder);
  }
  // Defensive: `repoHasOnlyRegistrySpecs` already bounds the entries of all root lockfiles; this per-lockfile bound keeps the function safe alone.
  let visited = 0;
  for (const entry of Object.values(packages)) {
    if (++visited > MAX_LOCK_INDEX_NODES) return null;
    if (!isPlainObject(entry) || !entry.link) continue;
    if (entry.link !== true || !proven.has(entry.resolved as string)) return null;
  }
  return proven;
}

/**
 * Pure: the `packages` key npm resolves the dependency `key` of the workspace
 * member at `folder` from (both relative to the root's lockfile): the member's
 * own `<folder>/node_modules/<key>` when the lockfile has it, else the root's
 * `node_modules/<key>`. Null when a folder between them has a
 * `<parent>/node_modules/<key>` entry (a member nested in another member):
 * this scan does not follow such a chain. Also null for a folder that is no
 * member folder (`isMemberFolder`: nested past `MAX_MEMBER_FOLDER_SEGMENTS`
 * or `MAX_MEMBER_FOLDER_CHARS` included), so the cost of one call is bounded.
 */
export function workspaceMemberLockKey(packages: Record<string, unknown>, folder: string, key: string): string | null {
  if (!isMemberFolder(folder)) return null;
  const own = `${folder}/${NODE_MODULES}${key}`;
  if (hasOwn(packages, own)) return own;
  for (let i = folder.lastIndexOf('/'); i > 0; i = folder.lastIndexOf('/', i - 1)) {
    if (hasOwn(packages, `${folder.slice(0, i)}/${NODE_MODULES}${key}`)) return null;
  }
  return `${NODE_MODULES}${key}`;
}

/**
 * Index what the fetched lockfiles install, in one pass: top level, nested
 * under another package, aliased installs, and the legacy `dependencies`
 * mirror of a v2 lockfile. Every entry that names a package must yield a semver
 * version, else its name goes to `unknown` (the root `""` entry, `link: true`
 * entries and version-less workspace folder entries are exempt). Returns null
 * ("not provable for any name") when a lockfile is missing, unparsed or of an
 * unknown shape (lockfileVersion 1 included), an entry cannot be attributed to
 * a name at all (an unparsable `name`, an unparsable `npm:` version, a key
 * without a name), an entry has an edge to a name the same lockfile has no
 * entry for (see below), or the total node budget is exhausted.
 */
function buildInstalledIndex(locks: Iterable<NarrowLockfile | null>): InstalledIndex | null {
  const versions = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  let visited = 0;
  const record = (name: string, version: string): void => {
    let set = versions.get(name);
    if (!set) {
      set = new Set();
      versions.set(name, set);
    }
    set.add(version);
    const normalised = semver.valid(version);
    if (normalised !== null) set.add(normalised);
  };
  for (const lock of locks) {
    if (lock === null) return null;
    const { packages } = lock;
    const { dependencies } = lock.data;
    // Names this lockfile has an entry for (by key), and the edges its entries
    // have: `dependencies`, `optionalDependencies` and `peerDependencies` (a
    // peer the entry's own `peerDependenciesMeta` marks optional excepted).
    const entryNames = new Set<string>();
    const edges: Array<{ key: string; spec: unknown; bundled: boolean }> = [];
    for (const [key, entry] of Object.entries(packages)) {
      if (++visited > MAX_LOCK_INDEX_NODES) return null;
      const tail = nameFromPackagesKey(key);
      if (tail !== undefined) entryNames.add(tail);
      // An entry the lockfile itself lists as bundled carries its own
      // dependencies inside the package, so its edges need no entry here.
      if (isPlainObject(entry) && entry.inBundle !== true) {
        const bundledNames = bundledNamesOf(entry);
        const peerMeta = isPlainObject(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : undefined;
        for (const field of EDGE_FIELDS) {
          const map = entry[field];
          if (map === undefined) continue;
          if (!isPlainObject(map)) return null;
          for (const [edgeKey, spec] of Object.entries(map)) {
            if (++visited > MAX_LOCK_INDEX_NODES) return null;
            if (field === 'peerDependencies' && peerIsOptional(peerMeta, edgeKey)) continue;
            edges.push({ key: edgeKey, spec, bundled: bundledNames.has(edgeKey) });
          }
        }
      }
      if (key === '') continue;
      if (tail === '') return null;
      if (!isPlainObject(entry)) {
        if (tail === undefined) return null;
        unknown.add(tail);
        continue;
      }
      if (entry.link === true) continue;
      const declared = entry.name;
      if (declared !== undefined && (typeof declared !== 'string' || declared === '')) return null;
      // A workspace package folder entry without a version names nothing installed.
      if (tail === undefined && entry.version === undefined) continue;
      const name = declared ?? tail ?? key.split('/').pop()!;
      const version = String(entry.version);
      if (semver.valid(version) === null) {
        unknown.add(name);
        continue;
      }
      record(name, version);
    }
    // An edge to a name the lockfile has no entry for means the lockfile is
    // not the whole install: `npm install` resolves the missing edge from the
    // registry (a lock written with `--legacy-peer-deps`, a damaged or
    // hand-edited lock), so nothing is provable. The one exception is a name
    // the entry itself lists in `bundleDependencies`: npm takes it from the
    // package tarball, so what it installs is unknown, not absent. (An alias
    // edge names the real package as well.) Edge ranges are not compared with
    // the versions the lockfile holds.
    for (const { key, spec, bundled } of edges) {
      if (entryNames.has(key)) continue;
      if (!bundled) return null;
      unknown.add(key);
      const aliasForm = typeof spec === 'string' && spec.trim().startsWith('npm:');
      const alias = aliasForm ? parseNpmAlias(spec) : null;
      if (alias) unknown.add(alias.realName);
      else if (aliasForm) return null;
    }
    if (dependencies !== undefined) {
      if (!isPlainObject(dependencies)) return null;
      // The legacy mirror of a v2 lockfile: nested `dependencies`. npm reads `packages`
      // when it is there; the mirror is scanned only so that a version it holds that
      // `packages` lacks keeps its name from being provably uninstalled.
      const stack: JsonObject[] = [dependencies];
      while (stack.length > 0) {
        const map = stack.pop()!;
        for (const [key, entry] of Object.entries(map)) {
          if (++visited > MAX_LOCK_INDEX_NODES) return null;
          if (!isPlainObject(entry)) {
            unknown.add(key);
            continue;
          }
          if (entry.dependencies !== undefined) {
            if (!isPlainObject(entry.dependencies)) return null;
            stack.push(entry.dependencies);
          }
          const raw = String(entry.version);
          const aliasForm = raw.trim().startsWith('npm:');
          const alias = aliasForm ? parseNpmAlias(raw) : null;
          // An `npm:` version that does not parse still installs some real
          // package; which one cannot be told, so no name is provable.
          if (aliasForm && alias === null) return null;
          const name = alias ? alias.realName : key;
          const version = alias ? alias.realSpec : raw;
          if (semver.valid(version) === null) {
            unknown.add(name);
            continue;
          }
          record(name, version);
        }
      }
    }
  }
  return { versions, unknown };
}

// Is `version` possibly installed for `name`? True for an unknown name, for an
// equal string, and for a semver-equal version ignoring build metadata.
function indexHas(index: InstalledIndex, name: string, version: string): boolean {
  if (index.unknown.has(name)) return true;
  const versions = index.versions.get(name);
  if (!versions) return false;
  if (versions.has(version)) return true;
  const normalised = semver.valid(version);
  return normalised !== null && versions.has(normalised);
}

// Does the lockfile list this declaration at `entryKey` (the manifest's own
// lockfile's top-level `node_modules/<key>`, or the entry a workspace member
// resolves it from)? A plain semver range additionally needs an installed,
// registry version (no alias under another name) that satisfies it, or a
// `link: true` entry that `linkSatisfies` accepts (none outside a proven
// workspace); any other spec (git, `file:`, tag, alias) only needs the entry
// to exist.
function lockfileListsDeclaration(
  lock: NarrowLockfile,
  decl: NarrowDeclaration,
  entryKey: string,
  linkSatisfies: (entry: JsonObject, decl: NarrowDeclaration) => boolean,
): boolean {
  const entry = ownValue(lock.packages, entryKey);
  if (!isPlainObject(entry)) return false;
  if (!isPlainSemverRange(decl.spec)) return true;
  if (entry.link === true) return linkSatisfies(entry, decl);
  if (entry.name !== undefined && entry.name !== decl.key) return false;
  return satisfiesLikeNpm(String(entry.version), decl.spec);
}

// Does every entry of the lockfile that installs one of the overridden names
// satisfy its override? (An override rewrites what npm installs for the name,
// at any depth; a lockfile made before the override was added, or edited by
// hand, can hold other versions.) An entry of an overridden name that has no
// readable version, or is not an object, fails. Entries are found by key name,
// by `name` field (aliases). `link` entries install no registry version and are skipped.
// (A `name` of the wrong type and an `npm:` version that cannot be parsed are
// not judged here: `buildInstalledIndex` refuses such a lockfile, which keeps
// every baseline entry.)
function lockfileHonoursOverrides(lock: NarrowLockfile, overrides: Map<string, string>): boolean {
  if (overrides.size === 0) return true;
  const check = (name: string | undefined, version: unknown): boolean => {
    if (name === undefined) return true; // a workspace folder entry without a name
    const range = overrides.get(name);
    if (range === undefined) return true;
    return typeof version === 'string' && satisfiesLikeNpm(version, range);
  };
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    const tail = nameFromPackagesKey(key);
    if (!isPlainObject(entry)) {
      if (tail !== undefined && overrides.has(tail)) return false;
      continue;
    }
    if (entry.link === true) continue;
    const named = typeof entry.name === 'string' ? entry.name : tail;
    if (!check(named, entry.version)) return false;
  }
  return true;
}

/**
 * Compute the narrow override (see the banner above) from the files the
 * fetchers read. Pure; never throws: an internal error yields "no additions,
 * nothing removable", i.e. the baseline.
 */
export function resolveNarrowNpm(inputs: NarrowNpmInputs): NarrowNpmResolution {
  try {
    return computeNarrowNpm(inputs);
  } catch {
    return NO_NARROW_RESOLUTION;
  }
}

function computeNarrowNpm(inputs: NarrowNpmInputs): NarrowNpmResolution {
  const { manifestPaths, observedLockfilePaths, observedTreeFacts } = inputs;

  // Tree walk complete: lockfile paths observed (the walk was not truncated and
  // did not fall back to a root probe), facts recorded, manifest list not cut at
  // its cap. Anything less and "no other manifest or lockfile exists" cannot be
  // proven, so there is no narrow resolution at all.
  const treeWalkComplete =
    observedLockfilePaths != null && observedTreeFacts != null && !observedTreeFacts.manifestsCapped;
  if (!treeWalkComplete) return NO_NARROW_RESOLUTION;

  const rawManifests = new Map(inputs.manifestFiles.map((f) => [f.path, f.content]));
  const manifestByPath = new Map<string, NarrowManifest | null>();
  for (const path of manifestPaths) {
    const raw = rawManifests.get(path);
    manifestByPath.set(path, raw === undefined ? null : readNarrowManifest(path, raw));
  }
  const manifests = [...manifestByPath.values()].filter((m): m is NarrowManifest => m !== null);

  const rawLocks = new Map(inputs.lockfileFiles.map((f) => [f.path, f.content]));
  const lockByPath = new Map<string, NarrowLockfile | null>();
  for (const path of npmLockfileFetchPaths(manifestPaths, observedLockfilePaths.npm)) {
    const raw = rawLocks.get(path);
    lockByPath.set(path, raw === undefined ? null : readNarrowLockfile(raw));
  }

  // No other package manager's lockfile (yarn.lock, pnpm-lock.yaml, bun.lock,
  // bun.lockb, npm-shrinkwrap.json) anywhere in the observed tree. With another
  // package manager's lockfile around, the package-lock.json files do not
  // necessarily describe what is installed, so there is no narrow resolution at
  // all (no additions below, and `dropSafe` is false).
  const noForeignLockfiles =
    observedTreeFacts.foreignLockfilePaths.length === 0 && observedLockfilePaths.yarn.length === 0;

  // No `.npmrc` anywhere in the observed tree and no `packageManager` field in
  // any manifest the scan reads: either can change what gets installed (an
  // `.npmrc` with `package-lock=false`, a manifest pinned to yarn) without the
  // package-lock.json saying so. Facts of an unexpected shape count as present.
  const noInstallPolicyFiles =
    Array.isArray(observedTreeFacts.npmrcPaths) &&
    observedTreeFacts.npmrcPaths.length === 0 &&
    Array.isArray(observedTreeFacts.packageManagerConfigPaths) &&
    observedTreeFacts.packageManagerConfigPaths.length === 0 &&
    manifests.every((m) => !pinsPackageManager(m.data));

  // Names the baseline never queries: another local package of the repo.
  const localNames = new Set(
    manifests.map((m) => m.data.name).filter((n): n is string => typeof n === 'string' && n !== ''),
  );

  // How each manifest is installed (`governanceOf`). Standalone: the manifest
  // and every package.json in a directory above it were read and parsed, and
  // none has a `workspaces` key (any value); its own lockfile installs it.
  // Root: it has a `workspaces` key and nothing above it does; its own lockfile
  // installs it, and `members` are the members that lockfile proves (null when
  // it proves none, `provenWorkspaceFolders`). Member: the one `workspaces` root
  // above it proves it; the root's lockfile installs it. Unknown: anything else
  // (an unread package.json at or above it, two `workspaces` keys at or above
  // it, a root that does not prove it). The ancestors come from the manifest
  // list, which is the whole tree here (not capped).
  type Governance =
    | { kind: 'standalone' }
    | { kind: 'root'; members: Map<string, NarrowManifest> | null }
    | { kind: 'member'; root: NarrowManifest; folder: string; members: Map<string, NarrowManifest> }
    | { kind: 'unknown' };
  const UNKNOWN: Governance = { kind: 'unknown' };

  // The manifests with a `workspaces` key in `dir` or a directory above it, or
  // null when a package.json there was not read and parsed.
  const workspaceRootsAt = (dir: string): NarrowManifest[] | null => {
    const roots: NarrowManifest[] = [];
    for (const path of manifestPaths) {
      if (!isSelfOrAncestorDir(dirOf(path), dir)) continue;
      const ancestor = manifestByPath.get(path);
      if (ancestor == null) return null;
      if (hasOwn(ancestor.data, 'workspaces')) roots.push(ancestor);
    }
    return roots;
  };

  // A member's folder relative to its root's directory.
  const folderBelow = (rootDir: string, dir: string): string => (rootDir === '' ? dir : dir.slice(rootDir.length + 1));

  // Can any workspace root be proven? Only when every dependency spec of every
  // read manifest and of every workspace root's own lockfile is a registry spec
  // (`repoHasOnlyRegistrySpecs`): any other spec may install a folder as a
  // project of its own, with the lockfile shape of a member. One pass over all
  // specs, here and only in a repository with a `workspaces` key.
  const workspaceRoots = manifests.filter((m) => hasOwn(m.data, 'workspaces'));
  const rootLockPackages: JsonObject[] = [];
  for (const root of workspaceRoots) {
    const lock = lockByPath.get(ownLockfilePath(root.dir));
    if (lock) rootLockPackages.push(lock.packages);
  }
  const workspacesProvable =
    workspaceRoots.length > 0 && repoHasOnlyRegistrySpecs(manifests.map((m) => m.data), rootLockPackages);

  // The members a root's own lockfile proves, by folder; computed once per root.
  const membersByRoot = new Map<string, Map<string, NarrowManifest> | null>();
  const provenMembersOf = (root: NarrowManifest): Map<string, NarrowManifest> | null => {
    if (membersByRoot.has(root.path)) return membersByRoot.get(root.path) ?? null;
    let members: Map<string, NarrowManifest> | null = null;
    const lock = lockByPath.get(ownLockfilePath(root.dir));
    if (lock && workspacesProvable) {
      const below = manifests.filter((m) => m !== root && isSelfOrAncestorDir(root.dir, m.dir));
      const candidates = below.map((m) => ({ folder: folderBelow(root.dir, m.dir), name: m.data.name, manifest: m }));
      const folders = provenWorkspaceFolders(root.data.workspaces, lock.data, candidates);
      if (folders) members = new Map(candidates.filter((c) => folders.has(c.folder)).map((c) => [c.folder, c.manifest]));
    }
    membersByRoot.set(root.path, members);
    return members;
  };

  const governanceByPath = new Map<string, Governance>();
  const governanceOf = (m: NarrowManifest): Governance => {
    const cached = governanceByPath.get(m.path);
    if (cached) return cached;
    let governance: Governance = UNKNOWN;
    const roots = workspaceRootsAt(m.dir);
    if (roots !== null && roots.length === 0) governance = { kind: 'standalone' };
    else if (roots !== null && roots.length === 1) {
      const root = roots[0];
      const members = provenMembersOf(root);
      if (root === m) governance = { kind: 'root', members };
      else {
        const folder = folderBelow(root.dir, m.dir);
        if (members !== null && members.get(folder) === m) governance = { kind: 'member', root, folder, members };
      }
    }
    governanceByPath.set(m.path, governance);
    return governance;
  };

  // The lockfile that installs M: its own, or its workspace root's.
  const governingLock = (m: NarrowManifest, g: Governance): NarrowLockfile | null => {
    if (g.kind === 'unknown') return null;
    const dir = g.kind === 'member' ? g.root.dir : m.dir;
    return lockByPath.get(ownLockfilePath(dir)) ?? null;
  };

  // A `link: true` entry for a declaration with a plain range, in a workspace
  // whose root lockfile proves `members`: it must resolve to a member of that
  // name whose package.json version (which npm reads for a linked member) the
  // range admits, and the lockfile's entry for the member folder must carry the
  // same version.
  const linkToMemberSatisfies =
    (lock: NarrowLockfile, members: Map<string, NarrowManifest> | null) =>
    (entry: JsonObject, decl: NarrowDeclaration): boolean => {
      if (members === null || typeof entry.resolved !== 'string') return false;
      const member = members.get(entry.resolved);
      if (!member || member.data.name !== decl.key) return false;
      const version = member.data.version;
      if (typeof version !== 'string' || semver.valid(version) === null) return false;
      const folderEntry = ownValue(lock.packages, entry.resolved);
      if (!isPlainObject(folderEntry) || folderEntry.version !== version) return false;
      return satisfiesLikeNpm(version, decl.spec);
    };

  // Every manifest the scan reads is locked. A manifest that was not read and
  // parsed is not (it could declare any name), nor is one whose governance is
  // unknown. Its governing lockfile (its own, or for a workspace member the
  // root's) was fetched and parsed, and lists every key of the manifest's
  // dependencies, devDependencies, optionalDependencies and peerDependencies
  // with a version that satisfies the declared range (see
  // `lockfileListsDeclaration`): at the top level of an own lockfile, at the
  // entry a member resolves it from (`workspaceMemberLockKey`) in the root's.
  // A project without such a lockfile installs fresh, transitively or through
  // `overrides`, and nothing here can see what. A member with `overrides` is not
  // locked: npm ignores them, and this scan does not vouch for them. With a
  // single manifest that is not locked no baseline entry is removed. (Additions
  // are not gated by this: they never remove anything. The known-shape
  // requirement is enforced for every fetched lockfile, this one included, by
  // `buildInstalledIndex`.) Computed on first use.
  const manifestLocked = (m: NarrowManifest): boolean => {
    const g = governanceOf(m);
    const lock = governingLock(m, g);
    if (!lock) return false;
    if (g.kind === 'member') {
      if (hasOwn(m.data, 'overrides')) return false;
      const linkSatisfies = linkToMemberSatisfies(lock, g.members);
      return m.declarations.every((d) => {
        if (!d.lockRequired) return true;
        const key = workspaceMemberLockKey(lock.packages, g.folder, d.key);
        return key !== null && lockfileListsDeclaration(lock, d, key, linkSatisfies);
      });
    }
    const linkSatisfies = linkToMemberSatisfies(lock, g.kind === 'root' ? g.members : null);
    return (
      m.overridesPlain &&
      lockfileHonoursOverrides(lock, m.overrides) &&
      m.declarations.every((d) => !d.lockRequired || lockfileListsDeclaration(lock, d, `${NODE_MODULES}${d.key}`, linkSatisfies))
    );
  };
  let everyManifestLockedMemo: boolean | undefined;
  const everyManifestLocked = (): boolean => {
    if (everyManifestLockedMemo === undefined) {
      everyManifestLockedMemo = manifestPaths.every((path) => {
        const m = manifestByPath.get(path);
        return m != null && manifestLocked(m);
      });
    }
    return everyManifestLockedMemo;
  };

  // The version `lock` installs for `name` at `entryKey`, or null.
  const lockVersionAt = (lock: NarrowLockfile, entryKey: string, name: string): string | null => {
    const entry = ownValue(lock.packages, entryKey);
    if (!isPlainObject(entry)) return null;
    // A real semver version: the loose range check below also accepts forms
    // such as `07.3.7`, which are no version to query.
    if (typeof entry.version !== 'string' || semver.valid(entry.version) === null) return null;
    if (entry.link === true) return null;
    if (entry.name !== undefined && entry.name !== name) return null;
    return entry.version;
  };

  // The version M installs for the dependency it declares as `decl` when M is
  // narrow for it, else null. Narrow means: a non-alias declaration with a plain
  // semver range, and an installed version at the top-level key of the
  // governing lockfile (above) that satisfies it. Standalone: any declaring
  // field. Workspace root or member: `dependencies` and `devDependencies` only,
  // the root's lockfile proves the membership, and a member resolves the name
  // from the root's top-level entry (a copy under its own folder, or a folder
  // between, keeps the floor).
  const narrowVersion = (m: NarrowManifest, decl: NarrowDeclaration): string | null => {
    const g = governanceOf(m);
    if (decl.aliasForm) return null; // the lockfile key is the local alias, not the name
    const topKey = `${NODE_MODULES}${decl.key}`;
    if (g.kind !== 'standalone') {
      if (decl.field !== 'dependencies' && decl.field !== 'devDependencies') return null;
      if (g.kind === 'root' && g.members === null) return null;
    }
    const lock = governingLock(m, g);
    if (!lock) return null;
    if (g.kind === 'member' && workspaceMemberLockKey(lock.packages, g.folder, decl.key) !== topKey) return null;
    const range = decl.spec.trim();
    // A spec that is no semver range (git, file:, tag, workspace:...) is
    // satisfied by nothing, so such a declaration is never narrow.
    const version = lockVersionAt(lock, topKey, decl.key);
    if (version === null) return null;
    return satisfiesLikeNpm(version, range) ? version : null;
  };

  const additions: Array<{ name: string; version: string }> = [];
  const seenAddition = new Set<string>();
  const declarers = new Map<string, Array<{ manifest: NarrowManifest; decl: NarrowDeclaration }>>();
  for (const manifest of manifests) {
    for (const decl of manifest.declarations) {
      const list = declarers.get(decl.realName) ?? [];
      list.push({ manifest, decl });
      declarers.set(decl.realName, list);
      if (!noForeignLockfiles) continue;
      if (!decl.addable) continue;
      if (decl.realName !== decl.key || localNames.has(decl.key)) continue;
      const version = narrowVersion(manifest, decl);
      if (version === null) continue;
      const id = `${decl.key}\u0000${version}`;
      if (seenAddition.has(id)) continue;
      seenAddition.add(id);
      additions.push({ name: decl.key, version });
    }
  }

  // Every manifest declaring the name (in any dependency field) is narrow for it.
  const declarersAllNarrow = (name: string): boolean => {
    if (localNames.has(name)) return false;
    const list = declarers.get(name) ?? [];
    if (list.length === 0) return false; // nothing declares it: nothing to prove narrow
    return list.every(({ manifest, decl }) => narrowVersion(manifest, decl) !== null);
  };

  // What the fetched lockfiles install, indexed once (lazily, on the first
  // removal question) so `dropSafe` only does lookups. Every lockfile the scan
  // reads must have been fetched and parsed; null means "not provable".
  let installedIndex: InstalledIndex | null | undefined;
  const baseVersionInstalledNowhere = (name: string, baseVersion: string): boolean => {
    if (installedIndex === undefined) installedIndex = buildInstalledIndex(lockByPath.values());
    if (installedIndex === null) return false;
    return !indexHas(installedIndex, name, baseVersion);
  };

  // narrowDropSafe
  const dropSafe = (name: string, baseVersion: string): boolean => {
    try {
      // The tree walk was complete here: without it computeNarrowNpm returned before building this.
      return (
        noForeignLockfiles &&
        noInstallPolicyFiles &&
        everyManifestLocked() &&
        declarersAllNarrow(name) &&
        baseVersionInstalledNowhere(name, baseVersion)
      );
    } catch {
      return false;
    }
  };

  return { additions, dropSafe };
}

async function resolveDefaultBranch(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

// A 404 on the tree or the root listing may mean the repository itself is gone
// or hidden from the token; confirm once per scan with the repository lookup.
function confirmWholeRepo(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
): Promise<void> {
  return confirmRepositoryReadable(() => octokit.rest.repos.get({ owner, repo }));
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
  } catch (err) {
    if (!isNothingThere(err)) noteDegraded('GitHub root listing', err);
    else if ((err as { status?: unknown }).status === 404) await confirmWholeRepo(octokit, owner, repo);
    return [];
  }
}
