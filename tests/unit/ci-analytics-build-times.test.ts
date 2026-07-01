// Unit tests for lib/ci/analytics/build-times.ts
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import module last.
// Asserts exact prisma.repo.findUnique where/include clause and hand-computed
// p50/p95 (with linear interpolation)/min/max/avg for overall, byBranch, and jobs.
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
import { getWorkflowBuildTimes } from '@/lib/ci/analytics/build-times';

describe('getWorkflowBuildTimes', () => {
  const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

  beforeEach(() => {
    repoFindUnique.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) returns [] when repo is not found (ownership miss)', async () => {
    repoFindUnique.mockResolvedValue(null);

    const result = await getWorkflowBuildTimes('repo-missing', 30);

    expect(result).toEqual([]);
  });

  it('(2) scopes the query to repoId, status=completed, non-null durations, and the exact since-date window', async () => {
    repoFindUnique.mockResolvedValue(null);

    await getWorkflowBuildTimes('repo-42', 7);

    const expectedSince = new Date(FIXED_NOW);
    expectedSince.setDate(expectedSince.getDate() - 7);

    expect(repoFindUnique).toHaveBeenCalledWith({
      where: { id: 'repo-42' },
      include: {
        workflows: {
          include: {
            runs: {
              where: {
                runCreatedAt: { gte: expectedSince },
                durationMs: { not: null },
                status: 'completed',
              },
              select: {
                durationMs: true,
                headBranch: true,
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

  it('(3) returns all-null Percentiles with sampleSize 0 for a workflow with zero runs', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [{ id: 'wf-empty', name: 'Empty', runs: [] }],
    });

    const result = await getWorkflowBuildTimes('repo-1');

    expect(result).toEqual([
      {
        workflowId: 'wf-empty',
        repoFullName: 'acme/widgets',
        name: 'Empty',
        overall: { p50: null, p95: null, min: null, max: null, avg: null, sampleSize: 0 },
        byBranch: {},
        jobs: [],
      },
    ]);
  });

  it('(4) computes exact overall/byBranch/job percentiles with linear-interpolated p95 across 5 runs', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { durationMs: 1000, headBranch: 'main', jobs: [{ name: 'build', durationMs: 100 }] },
            { durationMs: 2000, headBranch: 'main', jobs: [{ name: 'build', durationMs: 200 }] },
            { durationMs: 3000, headBranch: 'main', jobs: [{ name: 'build', durationMs: 300 }] },
            { durationMs: 4000, headBranch: 'feature-x', jobs: [{ name: 'build', durationMs: 400 }] },
            { durationMs: 5000, headBranch: 'feature-x', jobs: [{ name: 'build', durationMs: 500 }] },
          ],
        },
      ],
    });

    const result = await getWorkflowBuildTimes('repo-1');

    // overall durations sorted: [1000,2000,3000,4000,5000]
    // p50: idx=(50/100)*4=2 -> sorted[2]=3000 (exact index, no interpolation)
    // p95: idx=(95/100)*4=3.8 -> lower=3(4000) upper=4(5000) -> 4000 + 0.8*(5000-4000) = 4800
    // avg = 15000/5 = 3000; min=1000; max=5000
    expect(result[0].overall).toEqual({
      p50: 3000,
      p95: 4800,
      min: 1000,
      max: 5000,
      avg: 3000,
      sampleSize: 5,
    });

    // main branch: [1000,2000,3000] -> p50 idx=1 -> 2000; p95 idx=1.9 -> lower=1(2000) upper=2(3000)
    // -> 2000 + 0.9*(3000-2000) = 2900; avg=2000
    expect(result[0].byBranch['main']).toEqual({
      p50: 2000,
      p95: 2900,
      min: 1000,
      max: 3000,
      avg: 2000,
      sampleSize: 3,
    });

    // feature-x branch: [4000,5000] -> p50 idx=0.5 -> lower=0(4000) upper=1(5000) -> 4500
    // p95 idx=0.95 -> lower=0(4000) upper=1(5000) -> 4000+0.95*1000=4950; avg=4500
    expect(result[0].byBranch['feature-x']).toEqual({
      p50: 4500,
      p95: 4950,
      min: 4000,
      max: 5000,
      avg: 4500,
      sampleSize: 2,
    });

    // job "build" durations [100,200,300,400,500] -> same shape as overall, scaled by /10
    expect(result[0].jobs).toEqual([
      {
        jobName: 'build',
        percentiles: { p50: 300, p95: 480, min: 100, max: 500, avg: 300, sampleSize: 5 },
      },
    ]);
  });

  it('(5) single-sample percentile returns that sample for p50/p95/min/max/avg without interpolation', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-2',
          name: 'Solo',
          runs: [{ durationMs: 7000, headBranch: 'main', jobs: [{ name: 'lint', durationMs: 700 }] }],
        },
      ],
    });

    const result = await getWorkflowBuildTimes('repo-1');

    expect(result[0].overall).toEqual({
      p50: 7000,
      p95: 7000,
      min: 7000,
      max: 7000,
      avg: 7000,
      sampleSize: 1,
    });
    expect(result[0].jobs).toEqual([
      { jobName: 'lint', percentiles: { p50: 700, p95: 700, min: 700, max: 700, avg: 700, sampleSize: 1 } },
    ]);
  });
});
