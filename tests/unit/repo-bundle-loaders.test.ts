// Unit tests for the DB-loading half of lib/export/repo-bundle.ts:
// loadRepoExportData and its three private loaders (loadCveScan, loadLicenseScan,
// loadDepsScan), exercised through the public loadRepoExportData entry point.
//
// tests/unit/repo-bundle.test.ts already covers the two pure functions
// (getMissingExportScans, buildRepoExportArchive) with NO prisma mock — this
// file does NOT duplicate those and mocks @/lib/prisma instead (PATTERN B).
//
// IDOR is the primary concern here: loadRepoExportData is the only gate between
// a caller's userId and a repo's scan data. The repo.findFirst where-clause is
// asserted exactly so that dropping `userId` (or `tracked`) from the query
// cannot silently leak cross-user data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { repoFindFirst, scanFindFirst, scanFindMany } = vi.hoisted(() => ({
  repoFindFirst: vi.fn(),
  scanFindFirst: vi.fn(),
  scanFindMany: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findFirst: repoFindFirst },
    scan: { findFirst: scanFindFirst, findMany: scanFindMany },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { loadRepoExportData } from '@/lib/export/repo-bundle';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REPO_ROW = {
  id: 'repo-1',
  fullName: 'owner/repo',
  owner: 'owner',
  name: 'repo',
  defaultBranch: 'main',
  language: 'TypeScript',
  lastScannedAt: null,
};

const CVE_SCAN_ROW = { id: 'cve-scan-1', cvePayload: {}, advisories: [{ id: 'adv-1' }] };
const LICENSE_SCAN_ROW = { id: 'lic-scan-1', licensePayload: {}, licenses: [{ id: 'lic-1' }] };

const REPO_SELECT = {
  id: true,
  fullName: true,
  owner: true,
  name: true,
  defaultBranch: true,
  language: true,
  lastScannedAt: true,
};

// prisma.scan.findFirst is used for the cve, license, AND (scanId-branch) deps
// loaders. loadRepoExportData starts all three loaders concurrently via
// Promise.all, but each loader synchronously issues its first `prisma.scan.*`
// call before its first await, so calls land in source order: cve, license,
// deps. Dispatching on the where-clause shape (rather than relying purely on
// call order) makes the mock robust regardless of scheduling.
function dispatchScanFindFirst(impl: { cve?: unknown; license?: unknown; deps?: unknown }) {
  scanFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ('cvePayload' in args.where) return impl.cve ?? null;
    if ('licensePayload' in args.where) return impl.license ?? null;
    return impl.deps ?? null;
  });
}

function findCveCall() {
  return scanFindFirst.mock.calls.find(([a]) => 'cvePayload' in (a as { where: Record<string, unknown> }).where)![0];
}

function findLicenseCall() {
  return scanFindFirst.mock.calls.find(([a]) => 'licensePayload' in (a as { where: Record<string, unknown> }).where)![0];
}

function findDepsCall() {
  return scanFindFirst.mock.calls.find(([a]) => {
    const where = (a as { where: Record<string, unknown> }).where;
    return !('cvePayload' in where) && !('licensePayload' in where);
  })![0];
}

beforeEach(() => {
  repoFindFirst.mockReset();
  scanFindFirst.mockReset();
  scanFindMany.mockReset();
});

// ---------------------------------------------------------------------------
// IDOR / ownership (security-critical)
// ---------------------------------------------------------------------------
describe('loadRepoExportData — IDOR / ownership scoping', () => {
  it('scopes repo.findFirst by { id, userId, tracked: true } — exact where clause', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: CVE_SCAN_ROW, license: LICENSE_SCAN_ROW });
    scanFindMany.mockResolvedValue([]);

    await loadRepoExportData('user-1', 'repo-1');

    expect(repoFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'user-1', tracked: true },
      select: REPO_SELECT,
    });
  });

  it('cross-user access: caller user-A querying a repo owned by user-B is scoped away (mock returns null) and throws access-denied', async () => {
    // The mock simulates the DB layer: because the where-clause includes
    // userId, a repo owned by a different user simply does not match and
    // findFirst legitimately returns null — this is the IDOR gate in action.
    repoFindFirst.mockResolvedValue(null);

    await expect(loadRepoExportData('user-A', 'repo-owned-by-user-B')).rejects.toThrow(
      'Repository not found or access denied',
    );

    // Assert the actual where.userId equals the passed caller userId, so a
    // mutation that drops `userId` from the where clause (and thus would let
    // the query match regardless of owner) fails this test.
    const call = repoFindFirst.mock.calls[0][0] as { where: { userId: string; id: string } };
    expect(call.where.userId).toBe('user-A');
    expect(call.where.id).toBe('repo-owned-by-user-B');
  });

  it('success: returns {repo, cveScan, licenseScan, depsScan} from Promise.all when repo is found', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: CVE_SCAN_ROW, license: LICENSE_SCAN_ROW });
    const depsCandidate = { id: 'deps-1', dependencies: [{ id: 'd1' }], cvePayload: {}, licensePayload: {}, advisories: [], licenses: [] };
    scanFindMany.mockResolvedValue([depsCandidate]);

    const data = await loadRepoExportData('user-1', 'repo-1');

    expect(data).toEqual({
      repo: REPO_ROW,
      cveScan: CVE_SCAN_ROW,
      licenseScan: LICENSE_SCAN_ROW,
      depsScan: depsCandidate,
    });
  });
});

// ---------------------------------------------------------------------------
// loadCveScan (private, exercised via loadRepoExportData)
// ---------------------------------------------------------------------------
describe('loadCveScan', () => {
  it('default branch (no scanId): filters by repoId + status + cvePayload not DbNull, orders desc, includes advisories ordering', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: CVE_SCAN_ROW, license: LICENSE_SCAN_ROW });
    scanFindMany.mockResolvedValue([]);

    await loadRepoExportData('user-1', 'repo-1');

    expect(findCveCall()).toEqual({
      where: { repoId: 'repo-1', status: 'COMPLETED', cvePayload: { not: Prisma.DbNull } },
      orderBy: { scannedAt: 'desc' },
      include: { advisories: { orderBy: [{ severity: 'asc' }, { publishedAt: 'desc' }] } },
    });
  });

  it('scanId override branch: where.id equals the provided cveScanId, still scoped to repoId', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: CVE_SCAN_ROW, license: LICENSE_SCAN_ROW });
    scanFindMany.mockResolvedValue([]);

    await loadRepoExportData('user-1', 'repo-1', { cveScanId: 'scan-cve-99' });

    expect(findCveCall()).toEqual({
      where: { id: 'scan-cve-99', repoId: 'repo-1', status: 'COMPLETED', cvePayload: { not: Prisma.DbNull } },
      include: { advisories: { orderBy: [{ severity: 'asc' }, { publishedAt: 'desc' }] } },
    });
  });
});

// ---------------------------------------------------------------------------
// loadLicenseScan (private, exercised via loadRepoExportData)
// ---------------------------------------------------------------------------
describe('loadLicenseScan', () => {
  it('default branch (no scanId): filters by repoId + status + licensePayload not DbNull, orders desc, includes licenses ordering', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: CVE_SCAN_ROW, license: LICENSE_SCAN_ROW });
    scanFindMany.mockResolvedValue([]);

    await loadRepoExportData('user-1', 'repo-1');

    expect(findLicenseCall()).toEqual({
      where: { repoId: 'repo-1', status: 'COMPLETED', licensePayload: { not: Prisma.DbNull } },
      orderBy: { scannedAt: 'desc' },
      include: { licenses: { orderBy: [{ policyViolation: 'desc' }, { isCompatible: 'asc' }] } },
    });
  });

  it('scanId override branch: where.id equals the provided licenseScanId, still scoped to repoId', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: CVE_SCAN_ROW, license: LICENSE_SCAN_ROW });
    scanFindMany.mockResolvedValue([]);

    await loadRepoExportData('user-1', 'repo-1', { licenseScanId: 'scan-lic-42' });

    expect(findLicenseCall()).toEqual({
      where: { id: 'scan-lic-42', repoId: 'repo-1', status: 'COMPLETED', licensePayload: { not: Prisma.DbNull } },
      include: { licenses: { orderBy: [{ policyViolation: 'desc' }, { isCompatible: 'asc' }] } },
    });
  });
});

// ---------------------------------------------------------------------------
// loadDepsScan — default branch (findMany, take:20, candidate filtering)
// ---------------------------------------------------------------------------
describe('loadDepsScan — default branch (findMany)', () => {
  it('queries findMany with the exact where/orderBy/take/include shape', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: null, license: null });
    scanFindMany.mockResolvedValue([]);

    await loadRepoExportData('user-1', 'repo-1');

    expect(scanFindMany).toHaveBeenCalledWith({
      where: { repoId: 'repo-1', status: 'COMPLETED' },
      orderBy: { scannedAt: 'desc' },
      take: 20,
      include: {
        dependencies: { orderBy: [{ status: 'asc' }, { ageInDays: 'desc' }] },
        advisories: { select: { id: true } },
        licenses: { select: { id: true } },
      },
    });
  });

  it('picks a candidate scan with dependencies.length > 0 over a non-candidate', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: null, license: null });
    const nonCandidate = { id: 's1', dependencies: [], cvePayload: {}, licensePayload: null, advisories: [{ id: 'a' }], licenses: [] };
    const candidate = { id: 's2', dependencies: [{ id: 'd1' }], cvePayload: {}, licensePayload: {}, advisories: [{ id: 'a' }], licenses: [{ id: 'l' }] };
    scanFindMany.mockResolvedValue([nonCandidate, candidate]);

    const data = await loadRepoExportData('user-1', 'repo-1');

    expect(data.depsScan).toEqual(candidate);
  });

  it('picks a candidate with all-null payloads/advisories/licenses when dependencies is empty', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: null, license: null });
    const nonCandidate = { id: 's1', dependencies: [], cvePayload: {}, licensePayload: null, advisories: [], licenses: [] };
    const candidate = { id: 's2', dependencies: [], cvePayload: null, licensePayload: null, advisories: [], licenses: [] };
    scanFindMany.mockResolvedValue([nonCandidate, candidate]);

    const data = await loadRepoExportData('user-1', 'repo-1');

    expect(data.depsScan).toEqual(candidate);
  });

  it('returns null when no scan in the list qualifies as a candidate', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: null, license: null });
    scanFindMany.mockResolvedValue([{ id: 's1', dependencies: [], cvePayload: {}, licensePayload: null, advisories: [], licenses: [] }]);

    const data = await loadRepoExportData('user-1', 'repo-1');

    expect(data.depsScan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadDepsScan — scanId branch (findFirst, null-guards)
// ---------------------------------------------------------------------------
describe('loadDepsScan — scanId branch (findFirst)', () => {
  it('queries findFirst with the exact where/include shape scoped by id + repoId + status', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    const depsRow = { id: 's', dependencies: [{ id: 'd' }], advisories: [], licenses: [], cvePayload: null, licensePayload: null };
    dispatchScanFindFirst({ cve: null, license: null, deps: depsRow });

    await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'scan-deps-5' });

    expect(findDepsCall()).toEqual({
      where: { id: 'scan-deps-5', repoId: 'repo-1', status: 'COMPLETED' },
      include: {
        dependencies: { orderBy: [{ status: 'asc' }, { ageInDays: 'desc' }] },
        advisories: { select: { id: true } },
        licenses: { select: { id: true } },
      },
    });
  });

  it('returns null when the scan is not found', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({ cve: null, license: null, deps: null });

    const data = await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'missing' });

    expect(data.depsScan).toBeNull();
  });

  it('returns null when advisories.length > 0 (a CVE scan already occupies this row)', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({
      cve: null,
      license: null,
      deps: { id: 's', advisories: [{ id: 'a' }], licenses: [], cvePayload: null, licensePayload: null },
    });

    const data = await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'x' });

    expect(data.depsScan).toBeNull();
  });

  it('returns null when licenses.length > 0 (a license scan already occupies this row)', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({
      cve: null,
      license: null,
      deps: { id: 's', advisories: [], licenses: [{ id: 'l' }], cvePayload: null, licensePayload: null },
    });

    const data = await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'x' });

    expect(data.depsScan).toBeNull();
  });

  it('returns null when cvePayload is not null', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({
      cve: null,
      license: null,
      deps: { id: 's', advisories: [], licenses: [], cvePayload: {}, licensePayload: null },
    });

    const data = await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'x' });

    expect(data.depsScan).toBeNull();
  });

  it('returns null when licensePayload is not null', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    dispatchScanFindFirst({
      cve: null,
      license: null,
      deps: { id: 's', advisories: [], licenses: [], cvePayload: null, licensePayload: {} },
    });

    const data = await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'x' });

    expect(data.depsScan).toBeNull();
  });

  it('returns the scan when all null-guards pass (pure deps scan)', async () => {
    repoFindFirst.mockResolvedValue(REPO_ROW);
    const depsScan = { id: 's', advisories: [], licenses: [], cvePayload: null, licensePayload: null, dependencies: [{ id: 'd' }] };
    dispatchScanFindFirst({ cve: null, license: null, deps: depsScan });

    const data = await loadRepoExportData('user-1', 'repo-1', { depsScanId: 'x' });

    expect(data.depsScan).toEqual(depsScan);
  });
});
