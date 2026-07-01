// Unit tests for lib/ci/analytics/bottleneck.ts
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import module last.
// Asserts exact prisma.repo.findUnique where/include clause (ownership + since-date
// window) and hand-computed avg/median/p95/durationShare/rank values.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { repoFindUnique } = vi.hoisted(() => ({
  repoFindUnique: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findUnique: repoFindUnique,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { getBottlenecks } from '@/lib/ci/analytics/bottleneck';

describe('getBottlenecks', () => {
  const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

  beforeEach(() => {
    repoFindUnique.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) returns [] and does not throw when repo is not found (ownership miss)', async () => {
    repoFindUnique.mockResolvedValue(null);

    const result = await getBottlenecks('repo-missing', 30);

    expect(result).toEqual([]);
  });

  it('(2) scopes the query to repoId, status=completed, non-null durations, and the exact since-date window', async () => {
    repoFindUnique.mockResolvedValue(null);

    await getBottlenecks('repo-42', 30);

    const expectedSince = new Date(FIXED_NOW);
    expectedSince.setDate(expectedSince.getDate() - 30);

    expect(repoFindUnique).toHaveBeenCalledWith({
      where: { id: 'repo-42' },
      include: {
        workflows: {
          include: {
            runs: {
              where: {
                runCreatedAt: { gte: expectedSince },
                status: 'completed',
                durationMs: { not: null },
              },
              select: {
                durationMs: true,
                jobs: {
                  where: { durationMs: { not: null } },
                  select: { name: true, durationMs: true },
                },
              },
            },
          },
        },
      },
    });
  });

  it('(3) skips workflows with zero jobs across all runs (jobMap.size === 0 guard)', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        { id: 'wf-empty', name: 'Empty', runs: [] },
        { id: 'wf-no-jobs', name: 'NoJobs', runs: [{ durationMs: 1000, jobs: [] }] },
      ],
    });

    const result = await getBottlenecks('repo-1');

    expect(result).toEqual([]);
  });

  it('(4) computes exact avg/median(odd)/p95/share/rank across two jobs', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { durationMs: 10000, jobs: [{ name: 'build', durationMs: 1000 }, { name: 'test', durationMs: 500 }] },
            { durationMs: 12000, jobs: [{ name: 'build', durationMs: 2000 }, { name: 'test', durationMs: 1500 }] },
            { durationMs: 14000, jobs: [{ name: 'build', durationMs: 3000 }, { name: 'test', durationMs: 2500 }] },
            { durationMs: 16000, jobs: [{ name: 'build', durationMs: 4000 }] },
            { durationMs: 18000, jobs: [{ name: 'build', durationMs: 5000 }] },
          ],
        },
      ],
    });

    const result = await getBottlenecks('repo-1');

    // build: durations [1000,2000,3000,4000,5000] avg=3000 median(mid)=3000 p95(idx=4)=5000
    // test:  durations [500,1500,2500]           avg=1500 median(mid)=1500 p95(idx=2)=2500
    // totalAvgMs = 3000 + 1500 = 4500
    expect(result).toEqual([
      {
        jobName: 'build',
        workflowId: 'wf-1',
        workflowName: 'CI',
        repoFullName: 'acme/widgets',
        avgDurationMs: 3000,
        p50DurationMs: 3000,
        p95DurationMs: 5000,
        sampleSize: 5,
        durationShare: 0.667,
        rank: 1,
      },
      {
        jobName: 'test',
        workflowId: 'wf-1',
        workflowName: 'CI',
        repoFullName: 'acme/widgets',
        avgDurationMs: 1500,
        p50DurationMs: 1500,
        p95DurationMs: 2500,
        sampleSize: 3,
        durationShare: 0.333,
        rank: 2,
      },
    ]);
  });

  it('(5) computes true even-length median (distinct from the mean) and p95 with 4 samples', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-2',
          name: 'Deploy',
          runs: [
            { durationMs: 1000, jobs: [{ name: 'deploy', durationMs: 1000 }] },
            { durationMs: 2000, jobs: [{ name: 'deploy', durationMs: 2000 }] },
            { durationMs: 3000, jobs: [{ name: 'deploy', durationMs: 3000 }] },
            { durationMs: 10000, jobs: [{ name: 'deploy', durationMs: 10000 }] },
          ],
        },
      ],
    });

    const result = await getBottlenecks('repo-1');

    // sorted [1000,2000,3000,10000]; avg=4000; median=(2000+3000)/2=2500 (!= avg);
    // p95: idx=ceil(0.95*4)-1=3 -> 10000; single job -> durationShare = 1 (share of itself).
    expect(result).toEqual([
      {
        jobName: 'deploy',
        workflowId: 'wf-2',
        workflowName: 'Deploy',
        repoFullName: 'acme/widgets',
        avgDurationMs: 4000,
        p50DurationMs: 2500,
        p95DurationMs: 10000,
        sampleSize: 4,
        durationShare: 1,
        rank: 1,
      },
    ]);
  });

  it('(6) guards durationShare against divide-by-zero when all job durations are 0 (yields 0, not NaN/Infinity)', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-3',
          name: 'Noop',
          runs: [
            { durationMs: 0, jobs: [{ name: 'noop', durationMs: 0 }] },
            { durationMs: 0, jobs: [{ name: 'noop', durationMs: 0 }] },
          ],
        },
      ],
    });

    const result = await getBottlenecks('repo-1');

    expect(result).toHaveLength(1);
    expect(result[0].avgDurationMs).toBe(0);
    expect(result[0].durationShare).toBe(0);
    expect(Number.isNaN(result[0].durationShare)).toBe(false);
    expect(Number.isFinite(result[0].durationShare)).toBe(true);
  });
});
