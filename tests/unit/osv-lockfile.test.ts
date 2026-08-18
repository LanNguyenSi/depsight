/**
 * Integration tests for the CVE false-positive fix in fetchOsvAdvisories.
 *
 * These tests verify that collectDeps (inside fetchOsvAdvisories) sends the
 * RESOLVED lockfile version to OSV instead of the manifest floor. They mock
 * detectEcosystem and the manifest/lockfile fetchers so the dependency layer
 * is fully controlled, then inspect the OSV querybatch request body.
 *
 * npm scenarios:
 *  - RESOLVED-SAFE: lockfile resolved past the advisory range → OSV query gets
 *    the safe resolved version, not the floor → false positive eliminated
 *  - RESOLVED-VULNERABLE (negative control): lockfile still in advisory range →
 *    OSV query gets the vulnerable resolved version → real vuln NOT hidden
 *  - NO-LOCKFILE FALLBACK: no lockfile (empty resolution map) → OSV query gets
 *    the manifest floor (pre-fix behaviour preserved, no regression)
 *  - MONOREPO: root lockfile covers a workspace dep → resolved version used
 *
 * yarn scenarios (package-lock.json absent, yarn.lock present):
 *  - RESOLVED-SAFE: yarn.lock resolved past the advisory range → FP eliminated
 *  - RESOLVED-VULNERABLE (negative control): yarn.lock resolves to a
 *    vulnerable version → real vuln NOT hidden
 *  - NO-LOCKFILE FALLBACK: neither lockfile present → manifest floor
 *  - MERGE AGREE: package-lock.json and yarn.lock both present, agree on the
 *    resolved version → that version is used
 *  - MERGE DISAGREE (D-006): package-lock.json and yarn.lock both present,
 *    disagree on the resolved version → the dep is dropped from the merged
 *    map and the scan falls back to the manifest floor, not lowest-wins or
 *    npm-precedence
 *  - FAIL-SAFE: yarn resolver rejects → degrades to floor/npm resolution,
 *    scan does not throw
 *
 * python scenarios:
 *  - RESOLVED-SAFE: uv.lock resolves past the advisory range → FP eliminated
 *  - RESOLVED-VULNERABLE (negative control): lockfile resolves to a vulnerable
 *    version → real vuln NOT hidden
 *  - NO-LOCKFILE FALLBACK: no uv.lock/poetry.lock → OSV gets the pyproject floor
 *  - normalization: underscore in pyproject vs hyphen in lockfile still matches
 *  - FAIL-SAFE: lockfile fetch rejects → degrades to floor, scan does not throw
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- octokit mock -----------------------------------------------------------

vi.mock('@/lib/github', () => ({
  createGitHubClient: vi.fn(),
}));

// ---- manifest-discovery partial mock ----------------------------------------
// detectEcosystem and fetchNpmManifests are mocked so the package.json layer
// is fully controlled. fetchNpmLockfileResolutions is also mocked so we can
// directly inject the resolved-version Map and isolate the collectDeps logic.

const mockDetectEcosystem = vi.fn();
const mockFetchNpmManifests = vi.fn();
const mockFetchNpmLockfileResolutions = vi.fn();
const mockFetchYarnLockfileResolutions = vi.fn();

vi.mock('@/lib/manifest-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifest-discovery')>();
  return {
    ...actual,
    detectEcosystem: (...args: Parameters<typeof actual.detectEcosystem>) =>
      mockDetectEcosystem(...args),
    fetchNpmManifests: (...args: Parameters<typeof actual.fetchNpmManifests>) =>
      mockFetchNpmManifests(...args),
    fetchNpmLockfileResolutions: (
      ...args: Parameters<typeof actual.fetchNpmLockfileResolutions>
    ) => mockFetchNpmLockfileResolutions(...args),
    fetchYarnLockfileResolutions: (
      ...args: Parameters<typeof actual.fetchYarnLockfileResolutions>
    ) => mockFetchYarnLockfileResolutions(...args),
  };
});

// ---- python manifests partial mock ------------------------------------------
// collectPythonDeps and fetchPythonLockfileResolutions are mocked so the
// python manifest + lockfile layers are fully controlled.

const mockCollectPythonDeps = vi.fn();
const mockFetchPythonLockfileResolutions = vi.fn();

vi.mock('@/lib/manifests/python', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifests/python')>();
  return {
    ...actual,
    collectPythonDeps: (...args: Parameters<typeof actual.collectPythonDeps>) =>
      mockCollectPythonDeps(...args),
    fetchPythonLockfileResolutions: (
      ...args: Parameters<typeof actual.fetchPythonLockfileResolutions>
    ) => mockFetchPythonLockfileResolutions(...args),
  };
});

// ---- Module import (after mocks) --------------------------------------------

import { fetchOsvAdvisories } from '@/lib/cve/osv';

// ---- Helpers ----------------------------------------------------------------

const NPM_ECOSYSTEM_INFO = {
  ecosystem: 'npm' as const,
  supported: true,
  manifestFile: 'package.json',
  manifestPaths: ['package.json'],
};

const PYTHON_ECOSYSTEM_INFO = {
  ecosystem: 'python' as const,
  supported: true,
  manifestFile: 'pyproject.toml',
  manifestPaths: ['pyproject.toml'],
};

/** OSV querybatch response that reports no vulns for a single-query batch. */
const OSV_NO_VULNS = {
  ok: true,
  json: () => Promise.resolve({ results: [{ vulns: [] }] }),
};

/**
 * Build a `LockfileResolutions` fixture (task 18f6c239 Finding 1's
 * `{ resolved, ambiguous }` return shape) from plain [name, version] entries,
 * for `mockFetchNpmLockfileResolutions` / `mockFetchYarnLockfileResolutions`.
 */
function lr(
  resolved: Array<[string, string]> = [],
  ambiguous: Array<[string, string]> = [],
): { resolved: Map<string, string>; ambiguous: Map<string, string> } {
  return { resolved: new Map(resolved), ambiguous: new Map(ambiguous) };
}

/** Extract the OSV querybatch request body from the first fetch mock call. */
function osvQueryBody(mockFetch: ReturnType<typeof vi.fn>, callIndex = 0) {
  return JSON.parse(mockFetch.mock.calls[callIndex][1].body as string) as {
    queries: Array<{ version: string; package: { name: string; ecosystem: string } }>;
  };
}

// ---- npm Tests ------------------------------------------------------------------

describe('collectDeps / fetchOsvAdvisories — npm lockfile version selection (end-to-end)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDetectEcosystem.mockReset();
    mockFetchNpmManifests.mockReset();
    mockFetchNpmLockfileResolutions.mockReset();
    mockFetchYarnLockfileResolutions.mockReset();
    mockCollectPythonDeps.mockReset();
    mockFetchPythonLockfileResolutions.mockReset();

    // Default: npm repo with one package.json declaring glob ^10.3.0.
    mockDetectEcosystem.mockResolvedValue(NPM_ECOSYSTEM_INFO);
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { glob: '^10.3.0' } }]);
    // Default: no yarn.lock present (empty resolution map), so existing
    // package-lock.json-only tests are unaffected by the yarn lookup running
    // alongside it.
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr());

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('RESOLVED-SAFE: sends the lockfile-resolved version to OSV, not the manifest floor', async () => {
    // glob declared ^10.3.0 (floor 10.3.0 lies inside the advisory range <10.5.0)
    // but the lockfile has resolved it to 10.5.0 (the fix is already installed).
    // Without the fix: OSV would receive 10.3.0 → false positive.
    // With the fix:    OSV receives 10.5.0 → correctly no match.
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr([['glob', '10.5.0']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('glob');
    // THE FIX: resolved version sent, NOT the manifest floor (10.3.0).
    expect(body.queries[0].version).toBe('10.5.0');
  });

  it('RESOLVED-VULNERABLE (negative control): sends the resolved vulnerable version — real vulns must NOT be silently hidden', async () => {
    // glob declared ^10.3.0, lockfile resolves to 10.4.0 (still inside <10.5.0).
    // A broken "fix" might send 10.5.0 or skip it entirely.
    // The correct behaviour: send 10.4.0 so OSV correctly flags the advisory.
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr([['glob', '10.4.0']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    // NOT the manifest floor (10.3.0) and NOT the safe version (10.5.0).
    // Must be the exact resolved version so OSV can match the advisory.
    expect(body.queries[0].version).toBe('10.4.0');
  });

  it('NO-LOCKFILE FALLBACK: falls back to manifest floor when no lockfile is present', async () => {
    // No lockfile → empty resolution map → collectDeps falls back to stripping
    // the leading range operator from the manifest spec (pre-fix behaviour).
    // This is the regression guard: repos without lockfiles must not break.
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr());
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    // ^10.3.0 → strip leading operator → 10.3.0 (unchanged from pre-fix floor behaviour).
    expect(body.queries[0].version).toBe('10.3.0');
  });

  it('MONOREPO: resolves workspace dep version from root lockfile', async () => {
    // packages/x/package.json declares lodash: ^4.0.0 (floor 4.0.0).
    // Root package-lock.json resolves it to 4.17.21.
    // The fix must use 4.17.21 (resolved) not 4.0.0 (floor).
    mockDetectEcosystem.mockResolvedValue({
      ...NPM_ECOSYSTEM_INFO,
      manifestFile: 'packages/x/package.json',
      manifestPaths: ['packages/x/package.json'],
    });
    mockFetchNpmManifests.mockResolvedValue([
      { name: 'workspace-x', dependencies: { lodash: '^4.0.0' } },
    ]);
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr([['lodash', '4.17.21']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('lodash');
    // Resolved from root lockfile → 4.17.21, NOT the manifest floor (4.0.0).
    expect(body.queries[0].version).toBe('4.17.21');
  });

  it('FAIL-SAFE: a lockfile-resolver rejection degrades to the manifest floor, never aborts the whole scan', async () => {
    // If fetchNpmLockfileResolutions rejects, the `.catch(emptyLockfileResolutions)`
    // wrapper must make collectDeps degrade to the floor — NOT let the rejection
    // bubble up and return zero advisories for the entire repo (hiding every
    // real vuln). Without the wrapper, OSV is never queried and this test fails.
    mockFetchNpmLockfileResolutions.mockRejectedValue(new Error('lockfile fetch exploded'));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('glob');
    // Degraded to the manifest floor (10.3.0); the scan still runs.
    expect(body.queries[0].version).toBe('10.3.0');
  });

  // --------------------------------------------------------------------------
  // Fix-round 2 (task 18f6c239, review findings on commit 87ed8d9):
  //
  // Finding 1 (HIGH, correctness): collectDeps's floor-strip
  // (`versionSpec.replace(/^[^0-9]*/, '')`) yields '' for a manifest spec
  // with no digit at all (`*`, `latest`, `workspace:*`, an unversioned git
  // spec). Combined with an ambiguous (dropped) lockfile resolution, such a
  // dep used to be silently dropped from the OSV scan entirely — 0 queries
  // instead of the expected 1. The fix: a `resolved`/`ambiguous` pair
  // threaded from the parsers through `mergeLockfileResolutions`; `ambiguous`
  // (lowest of the conflicting versions) is consulted as a last resort only
  // when neither `resolved` nor the manifest floor has anything usable.
  //
  // Finding 2 (HIGH, security): the lockfileVersion 2/3 `packages` map used
  // to key every entry by its LAST node_modules/ path segment, even for an
  // ALIASED install, where that segment is the LOCAL alias, not the real
  // installed package. An aliased (vulnerable) install and a direct (safe)
  // install of the same real package would key under DIFFERENT names, so
  // only the safe direct resolution was ever queried — silently hiding the
  // vulnerable aliased install. The fix: prefer the entry's own `name` field
  // (which npm writes for an aliased install) when present.
  //
  // These tests compose the REAL parseNpmLockfileContentsList (the vi.mock
  // factory spreads the actual module) with the real collectDeps, so they
  // exercise the fix end-to-end, the same pattern as the existing yarn
  // "D-006 END-TO-END" test below.
  // --------------------------------------------------------------------------

  it('(a) npm-mirror D-006 END-TO-END: real npm-parser output for a two-entry conflicted package-lock.json degrades to the manifest floor', async () => {
    // Mirrors the yarn "D-006 END-TO-END" test below, but through the real
    // npm lockfileVersion 2/3 parser: direct glob@^10.3.0 (the default
    // manifest fixture) resolved 10.4.0, plus an unrelated nested transitive
    // glob@^7.1.6 resolved 7.2.3 — must reach OSV as the manifest floor
    // 10.3.0, neither 7.2.3 (false-negative lowest-wins) nor 10.4.0.
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/glob': { version: '10.4.0' },
        'node_modules/foreground-child/node_modules/glob': { version: '7.2.3' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    expect(body.queries[0].version).toBe('10.3.0');
  });

  it('(b) npm self-scan D-006 END-TO-END: the depsight semver@7.8.5/6.3.1 false-negative fixture degrades to the manifest floor', async () => {
    // Reproduces the concrete false negative measured on depsight's own
    // package-lock.json (see the parser-level unit test in
    // npm-lockfile.test.ts): semver declared ^7.8.5 directly, but the
    // lockfile also carries a nested semver@6.3.1 from an unrelated
    // transitive tree. Must reach OSV at the manifest floor 7.8.5.
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { semver: '^7.8.5' } }]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/semver': { version: '7.8.5' },
        'node_modules/some-dep/node_modules/semver': { version: '6.3.1' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('semver');
    expect(body.queries[0].version).toBe('7.8.5');
  });

  it('(c) FINDING 1 REGRESSION GUARD: a no-digit manifest spec plus an ambiguous lockfile resolution still produces an OSV query (from the ambiguous lowest), instead of being silently dropped', async () => {
    // Pre-fix: `versionSpec.replace(/^[^0-9]*/, '')` on `foo: '*'` yields '',
    // and the ambiguous lockfile resolution for `foo` was dropped with no
    // fallback — collectDeps produced ZERO queries for this dep (measured: 0
    // OSV queries instead of 3 for a small reproduction repo). Post-fix: the
    // `ambiguous` map's lowest-observed conflicting version (1.0.0) is used
    // as a last resort, so a query IS still sent.
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { foo: '*' } }]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/foo': { version: '2.0.0' },
        'node_modules/bar/node_modules/foo': { version: '1.0.0' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    // THE REGRESSION GUARD: a query is sent at all (pre-fix: zero queries).
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('foo');
    // The lowest of the two conflicting resolutions (1.0.0), not the floor
    // (unusable — '*' has no digit) and not the higher conflicting value.
    expect(body.queries[0].version).toBe('1.0.0');
  });

  it('(d) FINDING 2 ALIAS END-TO-END: an aliased dependency is queried under its REAL name, using the lockfile-resolved version', async () => {
    mockFetchNpmManifests.mockResolvedValue([
      { dependencies: { myLodash: 'npm:lodash-es@^4.0.0' } },
    ]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const aliasedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/myLodash': { name: 'lodash-es', version: '4.17.21' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([aliasedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    // Query key is the REAL name, not the local alias "myLodash".
    expect(body.queries[0].package.name).toBe('lodash-es');
    // Lockfile-resolved version, not the manifest floor (4.0.0).
    expect(body.queries[0].version).toBe('4.17.21');
  });

  it('(e) FINDING 2 SECURITY END-TO-END: an aliased vulnerable install plus a direct safe install of the same real package query the FLOOR of the real package, not the unrelated safe version', async () => {
    // "compat" aliases lodash-es at an old, vulnerable range; "lodash-es" is
    // also depended on directly at a newer, safe range. Before Finding 2's
    // fix, the lockfile side kept these under DIFFERENT keys ("compat"'s
    // path segment vs "lodash-es"), so the safe direct resolution alone
    // would have been queried, hiding the vulnerable aliased install.
    mockFetchNpmManifests.mockResolvedValue([
      {
        dependencies: {
          compat: 'npm:lodash-es@^3.0.0', // aliased, vulnerable range
          'lodash-es': '^4.0.0', // direct, safe range
        },
      },
    ]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const aliasedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/compat': { name: 'lodash-es', version: '3.0.5' }, // aliased install, vulnerable
        'node_modules/lodash-es': { version: '4.17.21' }, // direct install, safe
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([aliasedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('lodash-es');
    // Both lockfile entries now key under "lodash-es" and DISAGREE
    // (3.0.5 vs 4.17.21) → dropped per D-006 → falls back to the manifest
    // floor of the real package (the lower, vulnerable range's floor:
    // 3.0.0), NOT the unrelated safe direct version (4.17.21) and NOT the
    // exact vulnerable resolution (3.0.5, which is in `ambiguous` but the
    // usable floor wins over it per D-006).
    expect(body.queries[0].version).toBe('3.0.0');
  });

  // --------------------------------------------------------------------------
  // Fix-round 2 review (task 7fc55e6f, R2 finding on 18f6c239): collectDeps
  // gated the floor's usability on `floor !== ''`. A non-semver spec whose
  // text happens to contain a digit (e.g. a git spec
  // `github:acme/widget2#main`) strips to a non-empty but meaningless floor
  // (`2#main`) that used to count as "usable" and suppress the `ambiguous`
  // fallback, even though it can never match a real OSV package version — the
  // dep was queried but effectively unscanned. The fix raises the guard to
  // `semver.valid(floor) !== null`.
  // --------------------------------------------------------------------------

  it('(f) FLOOR USABILITY (task 7fc55e6f): a digit-bearing non-semver spec with conflicting lockfile copies queries the ambiguous lowest, not the meaningless floor', async () => {
    // widget's manifest spec is a git ref containing a digit
    // (`github:acme/widget2#main`): floor-strip
    // (`versionSpec.replace(/^[^0-9]*/, '')`) yields '2#main' — non-empty,
    // but not a real semver version, so it can never match a real OSV
    // package version. Pre-fix, `floor !== ''` accepted it as "usable" and
    // suppressed the ambiguous fallback entirely. Post-fix,
    // `semver.valid(floor) !== null` rejects it, so the lockfile's ambiguous
    // (conflicting 3.2.1/2.0.4) resolution is used instead, at its lowest
    // value.
    mockFetchNpmManifests.mockResolvedValue([
      { dependencies: { widget: 'github:acme/widget2#main' } },
    ]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/widget': { version: '3.2.1' },
        'node_modules/foo/node_modules/widget': { version: '2.0.4' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('widget');
    // THE FIX: the ambiguous lowest (2.0.4), not the meaningless floor
    // ('2#main', which the pre-fix `floor !== ''` guard would have sent).
    expect(body.queries[0].version).toBe('2.0.4');
  });

  it('(g) NEGATIVE CONTROL: a usable semver floor still wins over the ambiguous fallback', async () => {
    // Guards against a wrong fix that always prefers `ambiguous` once an
    // entry exists, or that widens the semver-usability check so far it also
    // rejects a perfectly normal manifest floor. D-006 order is unchanged:
    // resolved > usable floor > ambiguous.
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { widget: '^2.5.0' } }]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/widget': { version: '3.2.1' },
        'node_modules/foo/node_modules/widget': { version: '1.0.4' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('widget');
    // The usable floor (2.5.0) wins over the ambiguous lowest (1.0.4).
    expect(body.queries[0].version).toBe('2.5.0');
  });

  it('(h) NO-DIGIT CLASS: `latest` and `workspace:*` manifest specs also reach the ambiguous fallback (not just `*`)', async () => {
    // The existing regression-guard test (c) above only exercises `*`.
    // `latest` and `workspace:*` strip to '' the same way (no digit
    // anywhere) and must reach the same last-resort ambiguous fallback, not
    // be silently dropped.
    mockFetchNpmManifests.mockResolvedValue([
      { dependencies: { latestDep: 'latest', wsDep: 'workspace:*' } },
    ]);
    const { parseNpmLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/latestDep': { version: '2.0.0' },
        'node_modules/foo/node_modules/latestDep': { version: '1.0.0' },
        'node_modules/wsDep': { version: '5.0.0' },
        'node_modules/bar/node_modules/wsDep': { version: '4.0.0' },
      },
    });
    mockFetchNpmLockfileResolutions.mockResolvedValue(
      parseNpmLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(2);
    const byName = Object.fromEntries(body.queries.map((q) => [q.package.name, q.version]));
    expect(byName.latestDep).toBe('1.0.0');
    expect(byName.wsDep).toBe('4.0.0');
  });

  // --------------------------------------------------------------------------
  // Fix-round 2 (task 7fc55e6f, R2 review on this branch's own guard fix
  // above): raising the guard all the way to plain `semver.valid(floor) !==
  // null` was TOO STRICT — it also rejects a floor derived from an ordinary
  // RANGE spec (`^19`, `~1.2`, `2.x`, `>=1.2`, ...), which is common and
  // legitimate (measured: 4.9% of manifest specs across the pandora corpus),
  // silently diverting those deps to the ambiguous/drop path exactly like a
  // git ref. The corrected guard: keep the `semver.valid(floor)` fast path;
  // when it fails, try `semver.validRange(versionSpec)` (against the RAW
  // spec) + `semver.minVersion` before falling back further.
  // --------------------------------------------------------------------------

  it('(j) RANGE FLOOR (task 7fc55e6f fix-round-2, F1): a `^19`-shaped range spec with no lockfile match anywhere queries the range minVersion, not a raw floor or a drop', async () => {
    // `^19` strips to floor '19', which fails `semver.valid` (not a full
    // x.y.z) — but the SPEC is a perfectly ordinary semver range. Both
    // `resolved` and `ambiguous` are empty here (no lockfile at all), so the
    // ONLY way this dep still produces a query is the range-floor path:
    // `semver.validRange('^19')` succeeds and `semver.minVersion('^19')`
    // gives '19.0.0'. THIS TEST IS RED against the unfixed
    // `semver.valid(floor) !== null` guard alone (react would be dropped,
    // zero queries) — see the fix-round-2 mutation probe.
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { react: '^19' } }]);
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr());
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('react');
    expect(body.queries[0].version).toBe('19.0.0');
  });

  it('(k) RANGE-CHECK STILL FAILS -> DROP: a digit-bearing git-ref spec with no ambiguous entry and no lockfile match is dropped, not sent as a meaningless version', async () => {
    // `github:acme/widget2#main` fails BOTH the exact-floor check (floor
    // '2#main' is not a real semver version) AND the new range check
    // (`semver.validRange` on the raw spec is null — a git ref is not a
    // semver range either), unlike `^19` in (j) above. With no `ambiguous`
    // lockfile entry to fall back to, the dep must be DROPPED entirely, not
    // sent to OSV under a garbage value. The companion `glob` dep (from the
    // default manifest fixture) proves the scan still runs and only the
    // git-ref dep is missing.
    mockFetchNpmManifests.mockResolvedValue([
      { dependencies: { glob: '^10.3.0', widget: 'github:acme/widget2#main' } },
    ]);
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr());
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    // Only glob is queried; widget was dropped (no query for it at all).
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('glob');
  });

  it('(l) OUT-OF-SCOPE ALIAS LIMITATION: a MALFORMED `npm:` alias with no `@range` suffix is diverted to ambiguous/drop (known limitation, no alias parsing added here)', async () => {
    // `unionNpmDeps`'s own alias resolution (`parseNpmAlias`) cleanly
    // resolves any WELL-FORMED `npm:realName@range` alias BEFORE
    // `collectDeps` ever computes a floor — including one whose real name
    // contains a digit, e.g. `npm:h3@^1.0.0` resolves to name `h3`, range
    // `^1.0.0`, floor `1.0.0` (valid), and is therefore unaffected by this
    // task (verified empirically; NOT what this test exercises). The
    // genuine gap is a MALFORMED alias `parseNpmAlias` can't parse at all
    // (no `@range` suffix, e.g. a bare `npm:h3`): `resolveAliasedEntry`
    // leaves it as an unresolved raw spec under the LOCAL alias key, which
    // then floors to '3' (fails `semver.valid`) and also fails the range
    // check (`semver.validRange('npm:h3')` is null). With no lockfile entry,
    // it is dropped — pinned here as a documented out-of-scope limitation of
    // the alias handling, not fixed (no alias-parsing changes in this task).
    mockFetchNpmManifests.mockResolvedValue([
      { dependencies: { glob: '^10.3.0', h3alias: 'npm:h3' } },
    ]);
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr());
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    // Only glob is queried; the malformed alias was dropped, not queried
    // under its meaningless local-key floor.
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('glob');
  });
});

// ---- yarn Tests -----------------------------------------------------------------

describe('collectDeps / fetchOsvAdvisories: yarn.lock version selection (end-to-end)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDetectEcosystem.mockReset();
    mockFetchNpmManifests.mockReset();
    mockFetchNpmLockfileResolutions.mockReset();
    mockFetchYarnLockfileResolutions.mockReset();
    mockCollectPythonDeps.mockReset();
    mockFetchPythonLockfileResolutions.mockReset();

    // Default: npm repo (package.json + yarn.lock, no package-lock.json) with
    // one package.json declaring glob ^10.3.0.
    mockDetectEcosystem.mockResolvedValue(NPM_ECOSYSTEM_INFO);
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { glob: '^10.3.0' } }]);
    // No package-lock.json present.
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr());

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('RESOLVED-SAFE: sends the yarn.lock-resolved version to OSV, not the manifest floor', async () => {
    // glob declared ^10.3.0 (floor 10.3.0 lies inside the advisory range <10.5.0)
    // but yarn.lock has resolved it to 10.5.0 (the fix is already installed).
    // Without the fix: OSV would receive 10.3.0 → false positive.
    // With the fix:    OSV receives 10.5.0 → correctly no match.
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr([['glob', '10.5.0']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('glob');
    // THE FIX: yarn.lock-resolved version sent, NOT the manifest floor (10.3.0).
    expect(body.queries[0].version).toBe('10.5.0');
  });

  it('RESOLVED-VULNERABLE (negative control): sends the resolved vulnerable version, real vulns must NOT be silently hidden', async () => {
    // glob declared ^10.3.0, yarn.lock resolves to 10.4.0 (still inside <10.5.0).
    // A broken "fix" might send 10.5.0 or skip it entirely.
    // The correct behaviour: send 10.4.0 so OSV correctly flags the advisory.
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr([['glob', '10.4.0']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    // NOT the manifest floor (10.3.0) and NOT the safe version (10.5.0).
    // Must be the exact resolved version so OSV can match the advisory.
    expect(body.queries[0].version).toBe('10.4.0');
  });

  it('D-006 END-TO-END: real parser output for a two-block conflicted yarn.lock degrades to the manifest floor in the OSV query', async () => {
    // Composes the REAL parseYarnLockfileContentsList (the vi.mock factory
    // spreads the actual module, so this import is the genuine parser) with
    // the real collectDeps: the round-1 HIGH fixture (direct glob@^10.3.0
    // resolved 10.4.0 plus an unrelated transitive glob@^7.1.6 resolved
    // 7.2.3) must reach OSV as the manifest floor 10.3.0 — neither 7.2.3
    // (the false-negative lowest-wins pick) nor 10.4.0.
    const { parseYarnLockfileContentsList } = await import('@/lib/manifest-discovery');
    const conflictedLock = [
      'glob@^7.1.6:',
      '  version "7.2.3"',
      '  resolved "x"',
      '',
      'glob@^10.3.0:',
      '  version "10.4.0"',
      '  resolved "x"',
      '',
    ].join('\n');
    mockFetchYarnLockfileResolutions.mockResolvedValue(
      parseYarnLockfileContentsList([conflictedLock]),
    );
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    expect(body.queries[0].version).toBe('10.3.0');
  });

  it('NO-LOCKFILE FALLBACK: falls back to manifest floor when neither lockfile is present', async () => {
    // Neither package-lock.json nor yarn.lock → both resolution maps empty →
    // collectDeps falls back to stripping the leading range operator from the
    // manifest spec (pre-fix behaviour). Regression guard: repos without any
    // JS lockfile must not break.
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr());
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    // ^10.3.0 → strip leading operator → 10.3.0 (unchanged from pre-fix floor behaviour).
    expect(body.queries[0].version).toBe('10.3.0');
  });

  it('MERGE AGREE: package-lock.json and yarn.lock both present and agree, the agreed version is used', async () => {
    // A transitional/polyglot repo carrying both lockfiles that agree on the
    // resolved version: mergeLockfileResolutions keeps it.
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr([['glob', '10.4.0']]));
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr([['glob', '10.4.0']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    expect(body.queries[0].version).toBe('10.4.0');
  });

  it('D-006 MERGE DISAGREE: package-lock.json and yarn.lock present with different resolutions, drops to the manifest floor (not lowest-wins or npm-precedence)', async () => {
    // A transitional/polyglot repo carrying both lockfiles: package-lock.json
    // resolved glob to 10.5.0, yarn.lock resolved it to 10.3.1. Neither
    // "npm wins" nor "lower wins" is safe in general (a stale package-lock.json
    // left over from a migration can carry a HIGHER version than the yarn.lock
    // that reflects the real install, masking the real vuln behind a
    // safer-looking npm resolution). mergeLockfileResolutions drops the name
    // on disagreement, so collectDeps falls back to the manifest floor
    // (^10.3.0 → 10.3.0), not either lockfile's resolution.
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr([['glob', '10.5.0']]));
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr([['glob', '10.3.1']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('glob');
    expect(body.queries[0].version).toBe('10.3.0');
  });

  it('FAIL-SAFE: a yarn lockfile-resolver rejection degrades to the manifest floor, never aborts the whole scan', async () => {
    // If fetchYarnLockfileResolutions rejects, the `.catch(emptyLockfileResolutions)`
    // wrapper must make collectDeps degrade to the floor (or the npm
    // resolution, if any), NOT let the rejection bubble up and return zero
    // advisories for the entire repo (hiding every real vuln).
    mockFetchYarnLockfileResolutions.mockRejectedValue(new Error('yarn.lock fetch exploded'));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('glob');
    // Degraded to the manifest floor (10.3.0); the scan still runs.
    expect(body.queries[0].version).toBe('10.3.0');
  });

  it('(i) CROSS-FORMAT AMBIGUOUS UNION MERGE (task 7fc55e6f): a no-digit spec plus disagreeing npm/yarn resolutions queries the cross-format ambiguous lowest', async () => {
    // NOTE on naming (task 7fc55e6f fix-round-2, F6): this composes the REAL
    // `mergeLockfileResolutions` with the real `collectDeps`, but the two
    // per-format resolution maps below are synthesized directly via `lr(...)`
    // rather than produced by feeding real package-lock.json/yarn.lock text
    // through `parseNpmLockfileContentsList`/`parseYarnLockfileContentsList`
    // (unlike the "(a)"/"D-006 END-TO-END" tests above, which do parse real
    // lockfile text). So this is an end-to-end exercise of the MERGE step
    // only, not of either format's parser — hence "MERGE", not "END-TO-END",
    // in the title.
    //
    // `latest` strips to '' (no digit) — the manifest floor is unusable
    // either way. package-lock.json resolves the dep to 10.5.0 alone (no
    // in-format conflict, so it lands in npm's own `resolved` map);
    // yarn.lock resolves it to 9.3.1 alone (same, in yarn's own `resolved`
    // map). The two formats DISAGREE, so mergeLockfileResolutions drops the
    // name from the merged `resolved` map per D-006 and records the union's
    // LOWEST (9.3.1) in the merged `ambiguous` map — collectDeps must
    // consult that CROSS-FORMAT ambiguous entry too, not just a same-format
    // one (already covered by (f)/(g)/(h) above).
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { widget: 'latest' } }]);
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr([['widget', '10.5.0']]));
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr([['widget', '9.3.1']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('widget');
    expect(body.queries[0].version).toBe('9.3.1');
  });
});

// ---- python Tests ---------------------------------------------------------------

describe('collectDeps / fetchOsvAdvisories — python lockfile version selection (end-to-end)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDetectEcosystem.mockReset();
    mockFetchNpmManifests.mockReset();
    mockFetchNpmLockfileResolutions.mockReset();
    mockFetchYarnLockfileResolutions.mockReset();
    mockCollectPythonDeps.mockReset();
    mockFetchPythonLockfileResolutions.mockReset();

    // Default: python repo with pyproject.toml declaring jinja2>=3.1 (floor 3.1).
    mockDetectEcosystem.mockResolvedValue(PYTHON_ECOSYSTEM_INFO);
    mockCollectPythonDeps.mockResolvedValue([{ name: 'jinja2', version: '3.1' }]);

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('RESOLVED-SAFE: sends the lockfile-resolved version to OSV, not the pyproject floor', async () => {
    // jinja2>=3.1 (floor 3.1 lies inside a hypothetical advisory range <3.1.6)
    // but uv.lock has resolved it to 3.1.6 (the fix is already installed).
    // Without the fix: OSV would receive 3.1 → false positive.
    // With the fix:    OSV receives 3.1.6 → correctly no match.
    mockFetchPythonLockfileResolutions.mockResolvedValue(new Map([['jinja2', '3.1.6']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('jinja2');
    // THE FIX: resolved version sent, NOT the manifest floor (3.1).
    expect(body.queries[0].version).toBe('3.1.6');
  });

  it('RESOLVED-VULNERABLE (negative control): sends the resolved vulnerable version — real vulns must NOT be silently hidden', async () => {
    // jinja2>=3.0 declared, lockfile resolves to 3.1.2 (still inside a
    // hypothetical advisory range <3.1.4). A broken "fix" might send 3.1.4
    // (the safe version) or 3.0 (the floor) — either way the real finding hides.
    // The correct behaviour: send 3.1.2 so OSV correctly flags the advisory.
    mockCollectPythonDeps.mockResolvedValue([{ name: 'jinja2', version: '3.0' }]);
    mockFetchPythonLockfileResolutions.mockResolvedValue(new Map([['jinja2', '3.1.2']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('jinja2');
    // NOT the manifest floor (3.0) and NOT a safe version.
    // Must be the exact resolved version so OSV can match the advisory.
    expect(body.queries[0].version).toBe('3.1.2');
  });

  it('NO-LOCKFILE FALLBACK: falls back to pyproject floor when no lockfile is present', async () => {
    // No uv.lock/poetry.lock → empty resolution map → collectDeps falls back to
    // the manifest version. Regression guard: repos without lockfiles must not break.
    mockFetchPythonLockfileResolutions.mockResolvedValue(new Map());
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('jinja2');
    // Degraded to the pyproject floor version as collected by collectPythonDeps.
    expect(body.queries[0].version).toBe('3.1');
  });

  it('normalization: underscore in pyproject vs hyphen in lockfile still matches', async () => {
    // pyproject declares "my_package" (underscore); uv.lock uses "my-package"
    // (hyphen). Both normalize to "my-package" so the resolution lookup hits.
    mockCollectPythonDeps.mockResolvedValue([{ name: 'my_package', version: '1.0.0' }]);
    // Lockfile uses hyphen form (canonical) as key
    mockFetchPythonLockfileResolutions.mockResolvedValue(new Map([['my-package', '1.2.3']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    // Should be sent with the canonical name (hyphen) AND the resolved version.
    expect(body.queries[0].package.name).toBe('my-package');
    expect(body.queries[0].version).toBe('1.2.3');
  });

  it('FAIL-SAFE: a lockfile-resolver rejection degrades to the pyproject floor, scan does not throw', async () => {
    // If fetchPythonLockfileResolutions rejects, the `.catch(() => new Map())`
    // wrapper must make collectDeps degrade to the floor — NOT let the rejection
    // bubble up and return zero advisories for the entire repo.
    mockFetchPythonLockfileResolutions.mockRejectedValue(new Error('lockfile fetch exploded'));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries).toHaveLength(1);
    expect(body.queries[0].package.name).toBe('jinja2');
    // Degraded to the manifest floor; the scan still runs.
    expect(body.queries[0].version).toBe('3.1');
  });
});

describe('collectDeps: observedLockfilePaths wiring into the lockfile fetchers (task c2ddfe93 R1)', () => {
  // These pin the ONLY production call sites of the observed-path filter.
  // R1 found two surviving mutants here: swapping the npm/yarn sets and
  // reverting the wiring to null both left the whole suite green.
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDetectEcosystem.mockReset();
    mockFetchNpmManifests.mockReset();
    mockFetchNpmLockfileResolutions.mockReset();
    mockFetchYarnLockfileResolutions.mockReset();
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { glob: '^10.3.0' } }]);
    mockFetchNpmLockfileResolutions.mockResolvedValue(lr());
    mockFetchYarnLockfileResolutions.mockResolvedValue(lr());
    mockFetch = vi.fn();
    mockFetch.mockResolvedValue(OSV_NO_VULNS);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes .npm to the npm fetcher and .yarn to the yarn fetcher (no swap)', async () => {
    mockDetectEcosystem.mockResolvedValue({
      ...NPM_ECOSYSTEM_INFO,
      observedLockfilePaths: { npm: ['package-lock.json'], yarn: ['sub/yarn.lock'] },
    });

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    expect(mockFetchNpmLockfileResolutions.mock.calls[0][4]).toEqual(['package-lock.json']);
    expect(mockFetchYarnLockfileResolutions.mock.calls[0][4]).toEqual(['sub/yarn.lock']);
  });

  it('passes null to BOTH fetchers when the observed set is null (blind-probe fallback)', async () => {
    mockDetectEcosystem.mockResolvedValue({ ...NPM_ECOSYSTEM_INFO, observedLockfilePaths: null });

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    expect(mockFetchNpmLockfileResolutions.mock.calls[0][4]).toBeNull();
    expect(mockFetchYarnLockfileResolutions.mock.calls[0][4]).toBeNull();
  });

  it('passes null to BOTH fetchers when EcosystemInfo carries no observed set at all (legacy shape)', async () => {
    mockDetectEcosystem.mockResolvedValue({ ...NPM_ECOSYSTEM_INFO });

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    expect(mockFetchNpmLockfileResolutions.mock.calls[0][4]).toBeNull();
    expect(mockFetchYarnLockfileResolutions.mock.calls[0][4]).toBeNull();
  });
});
