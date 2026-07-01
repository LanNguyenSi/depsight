// Unit tests for lib/ci/analytics/cross-repo.ts
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import module last.
// cross-repo.ts composes getWorkflowBuildTimes/getBottlenecks/detectFlakyJobs
// (already covered by their own dedicated unit test files) with its own
// repo lookup + ciHealthScore/ciHealthStatus arithmetic, so those three sibling
// modules are mocked here to isolate cross-repo.ts's own guards and formula.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { repoFindUnique, repoFindMany, buildTimesMock, bottlenecksMock, flakyMock } = vi.hoisted(() => ({
  repoFindUnique: vi.fn(),
  repoFindMany: vi.fn(),
  buildTimesMock: vi.fn(),
  bottlenecksMock: vi.fn(),
  flakyMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findUnique: repoFindUnique,
      findMany: repoFindMany,
    },
  },
}));
vi.mock('@/lib/ci/analytics/build-times', () => ({ getWorkflowBuildTimes: buildTimesMock }));
vi.mock('@/lib/ci/analytics/bottleneck', () => ({ getBottlenecks: bottlenecksMock }));
vi.mock('@/lib/ci/analytics/flaky', () => ({ detectFlakyJobs: flakyMock }));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { getCIRepoHealthSummary, getAllCIHealthSummaries } from '@/lib/ci/analytics/cross-repo';

describe('getCIRepoHealthSummary', () => {
  const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

  beforeEach(() => {
    repoFindUnique.mockReset();
    repoFindMany.mockReset();
    buildTimesMock.mockReset();
    bottlenecksMock.mockReset();
    flakyMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) returns null when repo is not found (ownership miss), without calling the sibling analytics modules', async () => {
    repoFindUnique.mockResolvedValue(null);

    const result = await getCIRepoHealthSummary('repo-missing', 30);

    expect(result).toBeNull();
    expect(buildTimesMock).not.toHaveBeenCalled();
    expect(bottlenecksMock).not.toHaveBeenCalled();
    expect(flakyMock).not.toHaveBeenCalled();
  });

  it('(2) scopes the query to repoId, status=completed, and the exact since-date window', async () => {
    repoFindUnique.mockResolvedValue(null);

    await getCIRepoHealthSummary('repo-42', 7);

    const expectedSince = new Date(FIXED_NOW);
    expectedSince.setDate(expectedSince.getDate() - 7);

    expect(repoFindUnique).toHaveBeenCalledWith({
      where: { id: 'repo-42' },
      include: {
        _count: { select: { workflows: true } },
        workflows: {
          include: {
            runs: {
              where: { runCreatedAt: { gte: expectedSince }, status: 'completed' },
              select: { conclusion: true, durationMs: true },
            },
          },
        },
      },
    });
  });

  it('(3) guards overallFailRatePct/avgBuildTimeMs/p95BuildTimeMs against divide-by-zero/empty when there are zero runs (score=100, healthy)', async () => {
    repoFindUnique.mockResolvedValue({
      id: 'repo-1',
      fullName: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      lastScannedAt: null,
      _count: { workflows: 0 },
      workflows: [{ id: 'wf-1', name: 'CI', runs: [] }],
    });
    buildTimesMock.mockResolvedValue([]);
    bottlenecksMock.mockResolvedValue([]);
    flakyMock.mockResolvedValue([]);

    const result = await getCIRepoHealthSummary('repo-1');

    expect(result).toEqual({
      repoId: 'repo-1',
      repoFullName: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      lastScannedAt: null,
      period: 30,
      totalWorkflows: 0,
      totalRunsInPeriod: 0,
      overallFailRatePct: 0,
      avgBuildTimeMs: null,
      p95BuildTimeMs: null,
      flakyJobCount: 0,
      topBottleneck: null,
      ciHealthScore: 100,
      ciHealthStatus: 'healthy',
    });
    expect(Number.isNaN(result!.overallFailRatePct)).toBe(false);
  });

  it('(4) computes exact ciHealthScore/status at the healthy/warning boundary (score=70) and passes repo.id + period through to sibling modules', async () => {
    repoFindUnique.mockResolvedValue({
      id: 'repo-1',
      fullName: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      lastScannedAt: new Date('2026-06-30T00:00:00.000Z'),
      _count: { workflows: 3 },
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { conclusion: 'success', durationMs: 100000 },
            { conclusion: 'success', durationMs: 200000 },
            { conclusion: 'success', durationMs: 300000 },
            { conclusion: 'success', durationMs: 400000 },
            { conclusion: 'success', durationMs: 500000 },
          ],
        },
      ],
    });
    buildTimesMock.mockResolvedValue([{ overall: { p95: 600000 } }]);
    bottlenecksMock.mockResolvedValue([
      { rank: 2, jobName: 'test' },
      { rank: 1, jobName: 'build' },
    ]);
    flakyMock.mockResolvedValue([{ jobName: 'flaky1' }]);

    const result = await getCIRepoHealthSummary('repo-1', 30);

    // totalRuns=5 failed=0 -> overallFailRatePct=0 -> failPenalty=min(40,0)=0
    // avgBuildTimeMs = (100000+200000+300000+400000+500000)/5 = 300000
    // p95BuildTimeMs = avg of buildTimes p95s = 600000 -> slowPenalty=min(30,(600000/600000)*30)=30
    // ciHealthScore = max(0, round(100-0-30)) = 70 -> exactly the healthy/warning boundary (>=70 => healthy)
    expect(result).toEqual({
      repoId: 'repo-1',
      repoFullName: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      lastScannedAt: new Date('2026-06-30T00:00:00.000Z'),
      period: 30,
      totalWorkflows: 3,
      totalRunsInPeriod: 5,
      overallFailRatePct: 0,
      avgBuildTimeMs: 300000,
      p95BuildTimeMs: 600000,
      flakyJobCount: 1,
      topBottleneck: 'build',
      ciHealthScore: 70,
      ciHealthStatus: 'healthy',
    });
    expect(buildTimesMock).toHaveBeenCalledWith('repo-1', 30);
    expect(bottlenecksMock).toHaveBeenCalledWith('repo-1', 30);
    expect(flakyMock).toHaveBeenCalledWith('repo-1', { period: 30 });
  });

  it('(5) computes exact ciHealthScore/status at the warning/critical boundary (score=40) and one point below it (score=39, critical)', async () => {
    const baseRepo = {
      id: 'repo-1',
      fullName: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      lastScannedAt: null,
      _count: { workflows: 1 },
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          // 5 runs, all failed -> failRatePct=100 -> failPenalty=min(40,100*0.8=80)=40 (capped)
          runs: [
            { conclusion: 'failure', durationMs: 1000 },
            { conclusion: 'failure', durationMs: 1000 },
            { conclusion: 'failure', durationMs: 1000 },
            { conclusion: 'failure', durationMs: 1000 },
            { conclusion: 'failure', durationMs: 1000 },
          ],
        },
      ],
    };
    bottlenecksMock.mockResolvedValue([]);
    flakyMock.mockResolvedValue([]);

    // p95=400000 -> slowPenalty=(400000/600000)*30=20 -> score=100-40-20=40 -> warning (boundary, >=40)
    repoFindUnique.mockResolvedValue(baseRepo);
    buildTimesMock.mockResolvedValue([{ overall: { p95: 400000 } }]);
    const atBoundary = await getCIRepoHealthSummary('repo-1');
    expect(atBoundary!.ciHealthScore).toBe(40);
    expect(atBoundary!.ciHealthStatus).toBe('warning');

    // p95=420000 -> slowPenalty=21 -> score=100-40-21=39 -> critical (< 40)
    buildTimesMock.mockResolvedValue([{ overall: { p95: 420000 } }]);
    const belowBoundary = await getCIRepoHealthSummary('repo-1');
    expect(belowBoundary!.ciHealthScore).toBe(39);
    expect(belowBoundary!.ciHealthStatus).toBe('critical');
  });

  it('(6) topBottleneck falls back to null when no bottleneck has rank===1', async () => {
    repoFindUnique.mockResolvedValue({
      id: 'repo-1',
      fullName: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      lastScannedAt: null,
      _count: { workflows: 1 },
      workflows: [{ id: 'wf-1', name: 'CI', runs: [{ conclusion: 'success', durationMs: 1000 }] }],
    });
    buildTimesMock.mockResolvedValue([]);
    bottlenecksMock.mockResolvedValue([{ rank: 2, jobName: 'test' }]);
    flakyMock.mockResolvedValue([]);

    const result = await getCIRepoHealthSummary('repo-1');

    expect(result!.topBottleneck).toBeNull();
  });
});

describe('getAllCIHealthSummaries', () => {
  beforeEach(() => {
    repoFindUnique.mockReset();
    repoFindMany.mockReset();
    buildTimesMock.mockReset();
    bottlenecksMock.mockReset();
    flakyMock.mockReset();
    bottlenecksMock.mockResolvedValue([]);
    flakyMock.mockResolvedValue([]);
  });

  it('(7) scopes repo lookup to userId + tracked:true, filters out null summaries, and sorts ascending by ciHealthScore', async () => {
    repoFindMany.mockResolvedValue([{ id: 'repo-a' }, { id: 'repo-b' }, { id: 'repo-c' }]);
    repoFindUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'repo-a') {
        return Promise.resolve({
          id: 'repo-a',
          fullName: 'acme/a',
          owner: 'acme',
          name: 'a',
          lastScannedAt: null,
          _count: { workflows: 1 },
          workflows: [
            {
              id: 'wf-a',
              name: 'CI',
              runs: [
                { conclusion: 'success', durationMs: 1000 },
                { conclusion: 'success', durationMs: 1000 },
              ],
            },
          ],
        });
      }
      if (where.id === 'repo-b') {
        return Promise.resolve({
          id: 'repo-b',
          fullName: 'acme/b',
          owner: 'acme',
          name: 'b',
          lastScannedAt: null,
          _count: { workflows: 1 },
          workflows: [
            {
              id: 'wf-b',
              name: 'CI',
              runs: [
                { conclusion: 'failure', durationMs: 1000 },
                { conclusion: 'failure', durationMs: 1000 },
              ],
            },
          ],
        });
      }
      return Promise.resolve(null); // repo-c: not found -> excluded
    });
    buildTimesMock.mockImplementation((repoId: string) => {
      if (repoId === 'repo-b') return Promise.resolve([{ overall: { p95: 600000 } }]);
      return Promise.resolve([]);
    });

    const result = await getAllCIHealthSummaries('user-1', 30);

    expect(repoFindMany).toHaveBeenCalledWith({ where: { userId: 'user-1', tracked: true }, select: { id: true } });
    // repo-a: 0% fail, no slow penalty -> score 100 (healthy)
    // repo-b: 100% fail (failPenalty 40) + p95=600000 (slowPenalty 30) -> score 30 (critical)
    // repo-c: filtered out (null summary)
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.repoId)).toEqual(['repo-b', 'repo-a']);
    expect(result[0].ciHealthScore).toBe(30);
    expect(result[0].ciHealthStatus).toBe('critical');
    expect(result[1].ciHealthScore).toBe(100);
    expect(result[1].ciHealthStatus).toBe('healthy');
  });

  it('(8) returns [] when the user has no tracked repos', async () => {
    repoFindMany.mockResolvedValue([]);

    const result = await getAllCIHealthSummaries('user-empty', 30);

    expect(result).toEqual([]);
    expect(repoFindUnique).not.toHaveBeenCalled();
  });
});
