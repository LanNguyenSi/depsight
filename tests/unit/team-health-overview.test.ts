import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRepoFindMany = vi.fn();
const mockScanFindMany = vi.fn();
const mockDependencyGroupBy = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findMany: mockRepoFindMany,
    },
    scan: {
      findMany: mockScanFindMany,
    },
    dependency: {
      groupBy: mockDependencyGroupBy,
    },
  },
}));

describe('getTeamHealthOverview()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('excludes untracked repos and their scans from overview aggregates', async () => {
    mockRepoFindMany.mockResolvedValue([
      {
        id: 'repo-tracked',
        fullName: 'acme/tracked',
        owner: 'acme',
        name: 'tracked',
        language: 'TypeScript',
        lastScannedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);

    mockScanFindMany
      .mockResolvedValueOnce([
        {
          repoId: 'repo-tracked',
          riskScore: 80,
          cveCount: 10,
          criticalCount: 2,
          highCount: 3,
          mediumCount: 4,
          lowCount: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          repoId: 'repo-tracked',
          licenseIssues: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'deps-scan-tracked',
          repoId: 'repo-tracked',
          _count: { dependencies: 5 },
        },
      ]);

    mockDependencyGroupBy.mockResolvedValue([
      {
        scanId: 'deps-scan-tracked',
        _count: 3,
      },
    ]);

    const { getTeamHealthOverview } = await import('@/lib/overview/team-health');
    const overview = await getTeamHealthOverview('user-1');

    expect(mockRepoFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', tracked: true },
      orderBy: { updatedAt: 'desc' },
    });

    expect(mockScanFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        repo: { userId: 'user-1', tracked: true },
        status: 'COMPLETED',
        cvePayload: { not: Prisma.DbNull },
      },
      orderBy: { scannedAt: 'desc' },
      distinct: ['repoId'],
      select: {
        repoId: true,
        riskScore: true,
        cveCount: true,
        criticalCount: true,
        highCount: true,
        mediumCount: true,
        lowCount: true,
      },
    });

    expect(mockScanFindMany).toHaveBeenNthCalledWith(2, {
      where: {
        repo: { userId: 'user-1', tracked: true },
        status: 'COMPLETED',
        licenseCount: { gt: 0 },
      },
      orderBy: { scannedAt: 'desc' },
      distinct: ['repoId'],
      select: { repoId: true, licenseIssues: true },
    });

    expect(mockScanFindMany).toHaveBeenNthCalledWith(3, {
      where: {
        repo: { userId: 'user-1', tracked: true },
        status: 'COMPLETED',
        dependencies: { some: {} },
      },
      orderBy: { scannedAt: 'desc' },
      distinct: ['repoId'],
      select: { id: true, repoId: true, _count: { select: { dependencies: true } } },
    });

    expect(overview.aggregate).toEqual({
      totalRepos: 1,
      scannedRepos: 1,
      avgRiskScore: 80,
      totalCVEs: 10,
      totalCritical: 2,
      totalHigh: 3,
      totalLicenseIssues: 2,
      highRiskRepos: 1,
      mediumRiskRepos: 0,
      lowRiskRepos: 0,
      overallHealthScore: 32,
    });

    expect(overview.repos).toHaveLength(1);
    expect(overview.repos[0]).toMatchObject({
      repoId: 'repo-tracked',
      fullName: 'acme/tracked',
      riskScore: 80,
      cveCount: 10,
      licenseIssues: 2,
      outdatedDeps: 3,
      totalDeps: 5,
      healthScore: 32,
    });

    expect(overview.topRiskyRepos.map((repo) => repo.repoId)).toEqual(['repo-tracked']);
    expect(overview.mostOutdated.map((repo) => repo.repoId)).toEqual(['repo-tracked']);
  });
});
