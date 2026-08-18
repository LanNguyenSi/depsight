import semver from 'semver';
import { createGitHubClient } from '@/lib/github';
import {
  detectEcosystem,
  fetchNpmLockfileResolutions,
  fetchNpmManifests,
  fetchYarnLockfileResolutions,
  mergeLockfileResolutions,
  unionNpmDeps,
} from '@/lib/manifest-discovery';
import {
  collectPythonDeps,
  fetchPythonLockfileResolutions,
  normalizePythonPackageName,
} from '@/lib/manifests/python';
import { collectGoDeps } from '@/lib/manifests/go';
import { collectJavaDeps } from '@/lib/manifests/java';
import { collectRustDeps } from '@/lib/manifests/rust';
import { collectPhpDeps } from '@/lib/manifests/php';
import type { GitHubAdvisory, Severity } from '@/lib/cve/github-advisories';

// ---- Pure helpers ----------------------------------------------------------

/** Map a depsight ecosystem string to its OSV ecosystem name, or null if unsupported. */
export function osvEcosystem(eco: string): string | null {
  switch (eco) {
    case 'npm': return 'npm';
    case 'python': return 'PyPI';
    case 'go': return 'Go';
    case 'java': return 'Maven';
    case 'rust': return 'crates.io';
    case 'php': return 'Packagist';
    default: return null;
  }
}

// CVSS v3.1 metric numeric value tables
const AV_MAP: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC_MAP: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.50 };
const UI_MAP: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA_MAP: Record<string, number> = { H: 0.56, L: 0.22, N: 0.0 };

/**
 * Compute the CVSS v3.1 base score from a full vector string (e.g.
 * "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"). Returns 0 on parse
 * error or when all impact metrics are None. Implements the standard
 * ISCBase / ISC / Exploitability / Roundup formula from the CVSS 3.1 spec.
 */
export function cvssV3BaseScore(vector: string): number {
  // Accept both CVSS:3.0 and CVSS:3.1 prefixes
  const metricsStr = vector.replace(/^CVSS:3\.\d\//, '');
  const m: Record<string, string> = {};
  for (const part of metricsStr.split('/')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    m[part.slice(0, colon)] = part.slice(colon + 1);
  }

  const AV = AV_MAP[m['AV'] ?? ''];
  const AC = AC_MAP[m['AC'] ?? ''];
  const UI = UI_MAP[m['UI'] ?? ''];
  const S = m['S'];
  const C = CIA_MAP[m['C'] ?? ''];
  const I = CIA_MAP[m['I'] ?? ''];
  const A = CIA_MAP[m['A'] ?? ''];

  if (
    AV === undefined || AC === undefined || UI === undefined ||
    !S || C === undefined || I === undefined || A === undefined
  ) {
    return 0;
  }

  const scopeChanged = S === 'C';
  const PR = scopeChanged
    ? (PR_CHANGED[m['PR'] ?? ''] ?? 0)
    : (PR_UNCHANGED[m['PR'] ?? ''] ?? 0);

  // ISCBase: combined impact sub-score base
  const ISCBase = 1 - (1 - C) * (1 - I) * (1 - A);

  // Impact sub-score, scope-dependent.
  // Scope-changed uses the CVSS 3.1 formula (ISCBase*0.9731, exponent 13),
  // not the CVSS 3.0 form (ISCBase-0.02, exponent 15).
  const ISC = scopeChanged
    ? 7.52 * (ISCBase - 0.029) - 3.25 * Math.pow(ISCBase * 0.9731 - 0.02, 13)
    : 6.42 * ISCBase;

  if (ISC <= 0) return 0;

  const Exploitability = 8.22 * AV * AC * PR * UI;

  const raw = scopeChanged
    ? Math.min(1.08 * (ISC + Exploitability), 10)
    : Math.min(ISC + Exploitability, 10);

  // Roundup: smallest value to 1 decimal place >= raw
  return Math.ceil(raw * 10) / 10;
}

// ---- OSV API types ---------------------------------------------------------

interface OsvVulnRef {
  type: string;
  url: string;
}

interface OsvVulnRange {
  type: string;
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

interface OsvVulnAffected {
  package?: { ecosystem: string; name: string };
  ranges?: OsvVulnRange[];
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: OsvVulnAffected[];
  references?: OsvVulnRef[];
  published?: string;
}

// ---- Severity mapping ------------------------------------------------------

/**
 * Derive a depsight Severity from an OSV vuln record.
 * Preference order: database_specific.severity > CVSS_V3 score > UNKNOWN.
 * CVSS_V4 vectors are not scored; fall through to UNKNOWN.
 * NOTE: CVSS_V4-only records without database_specific.severity resolve to UNKNOWN (follow-up).
 */
export function mapOsvSeverity(vuln: OsvVuln): Severity {
  const ds = vuln.database_specific?.severity;
  if (ds) {
    const u = ds.toUpperCase();
    if (u === 'CRITICAL') return 'CRITICAL';
    if (u === 'HIGH') return 'HIGH';
    if (u === 'MODERATE' || u === 'MEDIUM') return 'MEDIUM';
    if (u === 'LOW') return 'LOW';
  }

  const cvssV3Entry = vuln.severity?.find((s) => s.type === 'CVSS_V3');
  if (cvssV3Entry) {
    const score = cvssV3BaseScore(cvssV3Entry.score);
    if (score >= 9.0) return 'CRITICAL';
    if (score >= 7.0) return 'HIGH';
    if (score >= 4.0) return 'MEDIUM';
    if (score > 0) return 'LOW';
  }

  return 'UNKNOWN';
}

// ---- Alias extraction ------------------------------------------------------

/**
 * Extract ghsaId and cveId from an OSV vuln's id and aliases array.
 *   ghsaId: first GHSA- alias, or id if it starts with GHSA-, else the OSV id itself.
 *   cveId:  first CVE- alias, or id if it starts with CVE-, else null.
 */
export function extractAliases(vuln: Pick<OsvVuln, 'id' | 'aliases'>): {
  ghsaId: string;
  cveId: string | null;
} {
  const aliases = vuln.aliases ?? [];
  const ghsaAlias = aliases.find((a) => a.startsWith('GHSA-'));
  const cveAlias = aliases.find((a) => a.startsWith('CVE-'));

  const ghsaId = ghsaAlias ?? vuln.id;
  const cveId = cveAlias ?? (vuln.id.startsWith('CVE-') ? vuln.id : null);

  return { ghsaId, cveId };
}

// ---- Vulnerable range extraction -------------------------------------------

export function extractVulnRangeInfo(
  vuln: OsvVuln,
  depName: string,
  osvEco: string,
  version: string,
): { vulnerableRange: string | null; fixedVersion: string | null } {
  if (!vuln.affected?.length) return { vulnerableRange: null, fixedVersion: null };

  // Collect ALL affected entries matching name+ecosystem; fall back to all
  // ecosystem-only matches.  Using filter (not find) is critical: real advisories
  // (e.g. GHSA-5j98-mcp5-4vw2) split their version ranges across multiple separate
  // affected entries, each with a single range, rather than one entry with multiple
  // ranges[].  A single .find() would silently discard every entry after the first.
  // Do NOT fall back to the full affected list (that could include other ecosystems).
  const entriesByNameAndEco = vuln.affected.filter(
    (a) => a.package?.name === depName && a.package?.ecosystem === osvEco,
  );
  const matchedEntries =
    entriesByNameAndEco.length > 0
      ? entriesByNameAndEco
      : vuln.affected.filter((a) => a.package?.ecosystem === osvEco);

  if (matchedEntries.length === 0) return { vulnerableRange: null, fixedVersion: null };

  // Build candidate list: all [introduced, upperBound) intervals across EVERY
  // matched entry / range that yield a representable range string. A single
  // range's `events` array can carry MULTIPLE introduced/fixed (or
  // introduced/last_affected) pairs — e.g. a package vulnerable again in a
  // later interval within the SAME range object — so events are walked IN
  // ORDER, pairing each `introduced` with the next terminating event, rather
  // than picking only the first `introduced` and first `fixed` overall.
  // `last_affected` is an INCLUSIVE upper bound (<=X), unlike `fixed` which is
  // EXCLUSIVE (<X); when present (and `fixed` is absent for that interval) it
  // is used for containment but never surfaced as fixedVersion, since there is
  // no known fixed version for a last_affected-bounded interval.
  type Candidate = {
    rangeStr: string;
    introduced: string | null;
    fixed: string | null;
    lastAffected: string | null;
  };
  const candidates: Candidate[] = [];

  const pushCandidate = (
    introduced: string | null,
    fixed: string | null,
    lastAffected: string | null,
  ) => {
    const parts: string[] = [];
    if (introduced) parts.push(`>=${introduced}`);
    if (fixed) parts.push(`<${fixed}`);
    else if (lastAffected) parts.push(`<=${lastAffected}`);
    const rangeStr = parts.length > 0 ? parts.join(' ') : null;
    if (rangeStr) {
      candidates.push({ rangeStr, introduced, fixed, lastAffected: fixed ? null : lastAffected });
    }
  };

  for (const entry of matchedEntries) {
    for (const range of (entry.ranges ?? [])) {
      const events = range.events ?? [];
      let pendingIntroduced: string | null = null;
      let inInterval = false;

      for (const evt of events) {
        if (evt.introduced !== undefined) {
          // A new `introduced` while one is already open means the previous
          // interval had no terminating event: emit it as open-ended.
          if (inInterval) pushCandidate(pendingIntroduced, null, null);
          pendingIntroduced = evt.introduced;
          inInterval = true;
        } else if (evt.fixed !== undefined) {
          pushCandidate(pendingIntroduced, evt.fixed, null);
          pendingIntroduced = null;
          inInterval = false;
        } else if (evt.last_affected !== undefined) {
          pushCandidate(pendingIntroduced, null, evt.last_affected);
          pendingIntroduced = null;
          inInterval = false;
        }
      }
      // Trailing `introduced` with no terminating event: open-ended range.
      if (inInterval) pushCandidate(pendingIntroduced, null, null);
    }
  }

  if (candidates.length === 0) return { vulnerableRange: null, fixedVersion: null };

  // Try to find exactly one candidate whose interval contains the queried
  // version. semver.coerce() is used for robustness with version strings
  // that include extra labels (e.g. "1.2.3.4" or "v1.2.3"). `fixed` bounds are
  // exclusive (<X); `lastAffected` bounds are inclusive (<=X).
  const coercedVersion = semver.coerce(version);

  const matching: Candidate[] = [];
  if (coercedVersion !== null) {
    for (const candidate of candidates) {
      const coercedIntroduced = candidate.introduced
        ? semver.coerce(candidate.introduced)
        : null;
      const coercedFixed = candidate.fixed ? semver.coerce(candidate.fixed) : null;
      const coercedLastAffected = candidate.lastAffected
        ? semver.coerce(candidate.lastAffected)
        : null;

      // Skip candidate if a required boundary cannot be coerced — treat as "not determinable".
      if (candidate.introduced && coercedIntroduced === null) continue;
      if (candidate.fixed && coercedFixed === null) continue;
      if (candidate.lastAffected && coercedLastAffected === null) continue;

      const afterIntroduced =
        !candidate.introduced || semver.gte(coercedVersion, coercedIntroduced!);
      const beforeFixed = !candidate.fixed || semver.lt(coercedVersion, coercedFixed!);
      const atOrBeforeLastAffected =
        !candidate.lastAffected || semver.lte(coercedVersion, coercedLastAffected!);

      if (afterIntroduced && beforeFixed && atOrBeforeLastAffected) {
        matching.push(candidate);
      }
    }
  }

  // Exactly one candidate contains the version: return it.
  if (matching.length === 1) {
    return {
      vulnerableRange: matching[0].rangeStr,
      fixedVersion: matching[0].fixed,
    };
  }

  // Fallback (version not coercible, no candidate matches, or ambiguous 2+):
  // return all candidate range strings joined by ", " and a single fixedVersion
  // only when all candidates share the same fixed value.
  const allRanges = candidates.map((c) => c.rangeStr).join(', ');
  const fixedValues = [...new Set(candidates.map((c) => c.fixed))];
  const sharedFixed = fixedValues.length === 1 ? fixedValues[0] : null;

  return {
    vulnerableRange: allRanges,
    fixedVersion: sharedFixed,
  };
}

// ---- Bounded concurrency helper --------------------------------------------

async function withConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const runWorker = async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
}

// ---- Dep collection --------------------------------------------------------

interface DepEntry {
  name: string;
  version: string;
}

/**
 * Collect the raw dep list for the given ecosystem. Returns name/version
 * pairs suitable for OSV querybatch. Deps with no usable concrete version
 * (no digit) are skipped.
 *
 * For npm: the resolved version from `package-lock.json` or `yarn.lock` (v1
 * classic) is used when available (eliminating false positives where the
 * lockfile has upgraded past the advisory range); the two formats are merged
 * agreement-or-floor per D-006 (see `mergeLockfileResolutions`): a name in
 * only one lockfile uses that version, a name in both is kept only when they
 * agree, and on disagreement the name is dropped so the manifest floor is
 * used for it. Falls back to stripping the leading range operator from the
 * manifest spec (the previous floor behaviour) when no lockfile entry is
 * found, so existing repos without lockfiles do not regress. That floor is
 * usable as an exact version only when it parses as a real semver version
 * (`semver.valid(floor) !== null`, task 7fc55e6f — R2 finding on 18f6c239):
 * a non-semver spec whose text happens to contain a digit (e.g. a git spec
 * `github:acme/widget2#main`) strips down to a non-empty but meaningless
 * value (`2#main`) that must NOT count as a usable exact version. Measured
 * against api.osv.dev/v1/querybatch: such a value is NOT silently unmatchable
 * — OSV returns an ARBITRARY, unfiltered result set for a version string it
 * cannot interpret (`lodash@"2#main"` returned 5 vulns in the same batch
 * where `lodash@"999.0.0"` returned 0 and a real resolved version returned
 * the correct 10), because `fetchOsvAdvisories` maps every vuln OSV returns
 * for a query with no further local version filtering. So a garbage floor
 * risks arbitrary OVER-reporting for that dep, not silence — a real observed
 * version is preferred whenever one is available. When the floor doesn't
 * parse as an exact version, a declared RANGE still gets its own precise
 * query: when `semver.validRange(versionSpec)` succeeds (`^19`, `~1.2`,
 * `2.x`, `>=1.2` — ordinary ranges whose floor-strip merely isn't a full
 * x.y.z), `semver.minVersion(versionSpec)` supplies the range's lowest
 * version (`^19` -> `19.0.0`) as the query version — more precise than the
 * pre-task raw-floor value would have been for the same range. Only when
 * NEITHER the exact-floor nor the range path yields anything (a git ref, a
 * malformed/unsupported `npm:` alias, or a genuinely version-free spec like
 * `*`/`latest`/`workspace:*`) does collection fall back to the dep's
 * `ambiguous`-map entry as a final, last-resort fallback (task 18f6c239
 * Finding 1): the lowest version observed among the lockfile's conflicting
 * resolutions for that name, if any — see the shared-helpers banner above
 * `LockfileResolutions` in manifest-discovery.ts for the full
 * ambiguous-fallback rationale and the D-006 ordering invariant (unchanged
 * here: resolved > usable floor (exact or range-derived) > ambiguous). The
 * resulting invariant: a declared dependency for which ANY USABLE version
 * information exists anywhere (lockfile, an exact or range-parseable
 * manifest spec, or an ambiguous lockfile entry) always produces an OSV
 * query. The one documented exception: a digit-bearing spec that is neither
 * a real semver version nor a parseable range (a git ref, an unsupported
 * alias form) with no `ambiguous` entry to fall back to is dropped from the
 * scan, same as any other dep with no usable version anywhere. pnpm-lock.yaml
 * is not resolved (deferred, see the comment above
 * `discoverYarnLockfilePaths` in manifest-discovery.ts) so pnpm repos still
 * get the manifest floor (or the `ambiguous` fallback, if even that is
 * unusable).
 */
async function collectDeps(
  eco: string,
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  manifestPaths: string[],
  // Lockfile paths OBSERVED during detectEcosystem's git-tree walk (task
  // c2ddfe93), threaded through from EcosystemInfo.observedLockfilePaths so
  // the npm/yarn lockfile fetchers below probe only paths known to exist
  // instead of blindly guessing every co-located candidate. `undefined`/null
  // (e.g. when the tree walk fell back to a root-only probe) preserves the
  // pre-task blind-probe behaviour.
  observedLockfilePaths?: { npm: string[]; yarn: string[] } | null,
): Promise<DepEntry[]> {
  switch (eco) {
    case 'npm': {
      const paths = manifestPaths.length > 0 ? manifestPaths : ['package.json'];
      const emptyLockfileResolutions = () => ({
        resolved: new Map<string, string>(),
        ambiguous: new Map<string, string>(),
      });
      const [manifests, npmLockfileResolutions, yarnLockfileResolutions] = await Promise.all([
        fetchNpmManifests(octokit, owner, repo, paths),
        // Best-effort: a lockfile-resolution failure must only ever degrade to
        // the manifest floor (per-dep fallback below), never reject and abort the
        // whole npm scan, which would return zero advisories and hide every
        // vuln for the repo.
        fetchNpmLockfileResolutions(octokit, owner, repo, paths, observedLockfilePaths?.npm ?? null)
          .catch(emptyLockfileResolutions),
        fetchYarnLockfileResolutions(octokit, owner, repo, paths, observedLockfilePaths?.yarn ?? null)
          .catch(emptyLockfileResolutions),
      ]);
      const { resolved: lockfileResolutions, ambiguous: ambiguousLockfileResolutions } =
        mergeLockfileResolutions([npmLockfileResolutions, yarnLockfileResolutions]);
      return unionNpmDeps(manifests)
        .map(({ name, versionSpec }) => {
          // Prefer the lockfile-resolved version (exact installed version) to
          // avoid false positives from the manifest floor. Fall back to the
          // floor-strip when neither lockfile is present or lists this dep;
          // full rationale for what counts as a "usable" floor (exact vs.
          // range-derived), the ambiguous last-resort, and the one documented
          // drop case is in the doc comment above this function. Mechanics:
          // `floor` is usable as-is when it parses as an exact semver version
          // (fast path); otherwise `rangeFloor()` tries the RAW `versionSpec`
          // as a semver RANGE (`floor !== ''` excludes the digit-free
          // wildcard class — `*`/`latest`/`workspace:*` — which
          // `semver.validRange` would otherwise accept as `*` and
          // `minVersion` would wrongly resolve to `0.0.0`) and returns its
          // `minVersion`; only when neither yields anything does the
          // `ambiguous` map (or, failing that, an empty string that drops the
          // dep) apply. D-006 ordering is unchanged: resolved > usable floor
          // (exact or range-derived) > ambiguous.
          const floor = versionSpec.replace(/^[^0-9]*/, '');
          const rangeFloor = (): string | null => {
            if (floor === '' || semver.validRange(versionSpec) === null) return null;
            return semver.minVersion(versionSpec)?.version ?? null;
          };
          const version =
            lockfileResolutions.get(name) ??
            (semver.valid(floor) !== null
              ? floor
              : (rangeFloor() ?? ambiguousLockfileResolutions.get(name) ?? ''));
          return { name, version };
        })
        .filter(({ version }) => /\d/.test(version));
    }

    case 'python': {
      const [pyDeps, lockfileResolutions] = await Promise.all([
        collectPythonDeps(octokit, owner, repo, manifestPaths),
        // Best-effort: a lockfile-resolution failure must only ever degrade to
        // the manifest floor (per-dep fallback below), never reject and abort
        // the whole python scan, which would return zero advisories and hide
        // every vuln for the repo.
        fetchPythonLockfileResolutions(octokit, owner, repo, manifestPaths).catch(
          () => new Map<string, string>(),
        ),
      ]);
      return pyDeps
        .map(({ name, version }) => {
          const canonicalName = normalizePythonPackageName(name);
          // Prefer the lockfile-resolved version (exact installed version) to
          // avoid false positives from the pyproject floor. Fall back to the
          // manifest floor when the lockfile is absent or doesn't list this dep.
          const resolvedVersion = lockfileResolutions.get(canonicalName) ?? version;
          return { name: canonicalName, version: resolvedVersion };
        })
        .filter(({ version }) => /\d/.test(version));
    }

    case 'go': {
      const goDeps = await collectGoDeps(octokit, owner, repo, manifestPaths);
      return goDeps.filter((d) => /\d/.test(d.version));
    }

    case 'java': {
      const javaDeps = await collectJavaDeps(octokit, owner, repo, manifestPaths);
      return javaDeps
        .map((d) => ({ name: `${d.groupId}:${d.artifactId}`, version: d.version }))
        .filter(({ version }) => /\d/.test(version));
    }

    case 'rust': {
      const rustDeps = await collectRustDeps(octokit, owner, repo, manifestPaths);
      return rustDeps.filter((d) => /\d/.test(d.version));
    }

    case 'php': {
      const phpDeps = await collectPhpDeps(octokit, owner, repo, manifestPaths);
      return phpDeps.filter(({ version }) => /\d/.test(version));
    }

    default:
      return [];
  }
}

// ---- Main export -----------------------------------------------------------

/**
 * Fetch CVE advisories for a repository from OSV.dev. Returns advisories (may
 * be empty) and the detected ecosystem string. Never throws — OSV is
 * supplementary. ecosystem is null only on a top-level unexpected error;
 * otherwise the detected ecosystem string is always returned even when
 * unsupported or when advisories is empty.
 */
export async function fetchOsvAdvisories(
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ advisories: GitHubAdvisory[]; ecosystem: string | null }> {
  try {
    // 1. Detect ecosystem
    const ecosystemInfo = await detectEcosystem(accessToken, owner, repo, branch);
    const eco = ecosystemInfo.ecosystem;
    const osvEco = osvEcosystem(eco);

    if (!ecosystemInfo.supported || !osvEco) {
      return { advisories: [], ecosystem: eco };
    }

    // 2. Collect deps (manifest-only, no registry lookups)
    const octokit = createGitHubClient(accessToken);
    let deps: DepEntry[];
    try {
      deps = await collectDeps(
        eco,
        octokit,
        owner,
        repo,
        ecosystemInfo.manifestPaths,
        ecosystemInfo.observedLockfilePaths,
      );
    } catch (err) {
      console.warn('[osv] dep collection failed:', err);
      return { advisories: [], ecosystem: eco };
    }

    if (deps.length === 0) return { advisories: [], ecosystem: eco };

    // 3. Batch-query OSV in chunks of <=1000 (OSV querybatch limit).
    //    Each chunk uses a 12s AbortController timeout.
    //    A failed/timeout chunk degrades to empty for that chunk only; other chunks are unaffected.
    const CHUNK_SIZE = 1000;
    const TIMEOUT_MS = 12_000;

    const vulnToDeps = new Map<string, DepEntry[]>();

    for (let chunkStart = 0; chunkStart < deps.length; chunkStart += CHUNK_SIZE) {
      const chunkDeps = deps.slice(chunkStart, chunkStart + CHUNK_SIZE);
      const chunkQueries = chunkDeps.map(({ name, version }) => ({
        version,
        package: { name, ecosystem: osvEco },
      }));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let chunkResults: Array<{ vulns?: Array<{ id: string }> }>;
      try {
        const resp = await fetch('https://api.osv.dev/v1/querybatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries: chunkQueries }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) {
          console.warn(`[osv] querybatch chunk at ${chunkStart} failed with status ${resp.status}`);
          continue; // degrade to empty for this chunk
        }
        const parsed = (await resp.json()) as { results: typeof chunkResults };
        chunkResults = parsed.results ?? [];
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`[osv] querybatch chunk at ${chunkStart} failed:`, err);
        continue; // degrade to empty for this chunk (abort/timeout or network error)
      }

      // Map each chunk result back to its corresponding dep (index alignment per chunk)
      for (let j = 0; j < chunkResults.length && j < chunkDeps.length; j++) {
        const vulns = chunkResults[j]?.vulns ?? [];
        for (const vuln of vulns) {
          const list = vulnToDeps.get(vuln.id) ?? [];
          list.push(chunkDeps[j]);
          vulnToDeps.set(vuln.id, list);
        }
      }
    }

    if (vulnToDeps.size === 0) return { advisories: [], ecosystem: eco };

    // 5. Fetch full vuln details with bounded concurrency (~8 parallel requests)
    const vulnIds = [...vulnToDeps.keys()];
    const vulnDetails = new Map<string, OsvVuln>();
    const CONCURRENCY = 8;

    await withConcurrency(vulnIds, CONCURRENCY, async (id) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(
          `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        clearTimeout(timeoutId);
        if (!resp.ok) {
          console.warn(`[osv] failed to fetch vuln ${id}: ${resp.status}`);
          return;
        }
        const vuln = (await resp.json()) as OsvVuln;
        vulnDetails.set(id, vuln);
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`[osv] failed to fetch vuln ${id}:`, err);
        // On abort/timeout, skip this vuln (treated as not found)
      }
    });

    // 6. Build one GitHubAdvisory per (vuln, affected dep)
    const advisories: GitHubAdvisory[] = [];
    for (const [vulnId, affectedDeps] of vulnToDeps) {
      const vuln = vulnDetails.get(vulnId);
      if (!vuln) continue;

      const { ghsaId, cveId } = extractAliases(vuln);
      const severity = mapOsvSeverity(vuln);
      const summary =
        vuln.summary ??
        (vuln.details ? vuln.details.slice(0, 200) : vulnId);
      const publishedAt = vuln.published ? new Date(vuln.published) : null;
      const url =
        vuln.references?.find((r) => r.type === 'ADVISORY')?.url ??
        `https://osv.dev/vulnerability/${vulnId}`;

      for (const dep of affectedDeps) {
        const { vulnerableRange, fixedVersion } = extractVulnRangeInfo(
          vuln,
          dep.name,
          osvEco,
          dep.version,
        );
        advisories.push({
          ghsaId,
          cveId,
          severity,
          summary,
          packageName: dep.name,
          ecosystem: eco,
          vulnerableRange,
          fixedVersion,
          publishedAt,
          url,
          source: 'osv',
        });
      }
    }

    return { advisories, ecosystem: eco };
  } catch (err) {
    console.warn('[osv] unexpected error in fetchOsvAdvisories:', err);
    return { advisories: [], ecosystem: null };
  }
}
