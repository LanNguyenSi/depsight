/**
 * Integration tests for the CVE false-positive fix in fetchOsvAdvisories.
 *
 * These tests verify that collectDeps (inside fetchOsvAdvisories) sends the
 * RESOLVED lockfile version to OSV instead of the manifest floor. They mock
 * detectEcosystem and fetchNpmManifests so the npm package.json layer is
 * controlled, and mock fetchNpmLockfileResolutions to control what the lockfile
 * resolver returns — then inspect the OSV querybatch request body.
 *
 * Scenarios:
 *  - RESOLVED-SAFE: lockfile resolved past the advisory range → OSV query gets
 *    the safe resolved version, not the floor → false positive eliminated
 *  - RESOLVED-VULNERABLE (negative control): lockfile still in advisory range →
 *    OSV query gets the vulnerable resolved version → real vuln NOT hidden
 *  - NO-LOCKFILE FALLBACK: no lockfile (empty resolution map) → OSV query gets
 *    the manifest floor (pre-fix behaviour preserved, no regression)
 *  - MONOREPO: root lockfile covers a workspace dep → resolved version used
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

/** OSV querybatch response that reports no vulns for a single-query batch. */
const OSV_NO_VULNS = {
  ok: true,
  json: () => Promise.resolve({ results: [{ vulns: [] }] }),
};

/** Extract the OSV querybatch request body from the first fetch mock call. */
function osvQueryBody(mockFetch: ReturnType<typeof vi.fn>, callIndex = 0) {
  return JSON.parse(mockFetch.mock.calls[callIndex][1].body as string) as {
    queries: Array<{ version: string; package: { name: string; ecosystem: string } }>;
  };
}

// ---- Tests ------------------------------------------------------------------

describe('collectDeps / fetchOsvAdvisories — lockfile version selection (end-to-end)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDetectEcosystem.mockReset();
    mockFetchNpmManifests.mockReset();
    mockFetchNpmLockfileResolutions.mockReset();

    // Default: npm repo with one package.json declaring glob ^10.3.0.
    mockDetectEcosystem.mockResolvedValue(NPM_ECOSYSTEM_INFO);
    mockFetchNpmManifests.mockResolvedValue([{ dependencies: { glob: '^10.3.0' } }]);

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
    mockFetchNpmLockfileResolutions.mockResolvedValue(new Map([['glob', '10.5.0']]));
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
    mockFetchNpmLockfileResolutions.mockResolvedValue(new Map([['glob', '10.4.0']]));
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
    mockFetchNpmLockfileResolutions.mockResolvedValue(new Map());
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
    mockFetchNpmLockfileResolutions.mockResolvedValue(new Map([['lodash', '4.17.21']]));
    mockFetch.mockResolvedValue(OSV_NO_VULNS);

    await fetchOsvAdvisories('tok', 'o', 'r', 'main');

    const body = osvQueryBody(mockFetch);
    expect(body.queries[0].package.name).toBe('lodash');
    // Resolved from root lockfile → 4.17.21, NOT the manifest floor (4.0.0).
    expect(body.queries[0].version).toBe('4.17.21');
  });

  it('FAIL-SAFE: a lockfile-resolver rejection degrades to the manifest floor, never aborts the whole scan', async () => {
    // If fetchNpmLockfileResolutions rejects, the `.catch(() => new Map())`
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
});
