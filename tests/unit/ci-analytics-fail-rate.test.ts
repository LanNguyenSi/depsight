// Unit tests for lib/ci/analytics/fail-rate.ts
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import module last.
// Covers getWorkflowFailRates, getAllFailRates, and getWorkflowFailRateMultiPeriod:
// exact failRate/failRatePct arithmetic, the total===0 divide-by-zero guard, and
// exact prisma call args (scoping + since-date window).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { repoFindUnique, repoFindMany, workflowFindFirst, workflowRunFindMany } = vi.hoisted(() => ({
  repoFindUnique: vi.fn(),
  repoFindMany: vi.fn(),
  workflowFindFirst: vi.fn(),
  workflowRunFindMany: vi.fn(),
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
    workflow: {
      findFirst: workflowFindFirst,
    },
    workflowRun: {
      findMany: workflowRunFindMany,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import {
  getWorkflowFailRates,
  getAllFailRates,
  getWorkflowFailRateMultiPeriod,
} from '@/lib/ci/analytics/fail-rate';

describe('getWorkflowFailRates', () => {
  const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

  beforeEach(() => {
    repoFindUnique.mockReset();
    repoFindMany.mockReset();
    workflowFindFirst.mockReset();
    workflowRunFindMany.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) returns [] when repo is not found (ownership miss)', async () => {
    repoFindUnique.mockResolvedValue(null);

    const result = await getWorkflowFailRates('repo-missing', 30);

    expect(result).toEqual([]);
  });

  it('(2) scopes the query to repoId and the exact since-date window', async () => {
    repoFindUnique.mockResolvedValue(null);

    await getWorkflowFailRates('repo-42', 1);

    const expectedSince = new Date(FIXED_NOW);
    expectedSince.setDate(expectedSince.getDate() - 1);

    expect(repoFindUnique).toHaveBeenCalledWith({
      where: { id: 'repo-42' },
      include: {
        workflows: {
          include: { runs: { where: { runCreatedAt: { gte: expectedSince } }, include: { jobs: true } } },
        },
      },
    });
  });

  it('(3) guards failRate against divide-by-zero when totalRuns is 0 (yields 0, not NaN)', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [{ id: 'wf-1', name: 'CI', runs: [] }],
    });

    const result = await getWorkflowFailRates('repo-1');

    expect(result).toEqual([
      {
        workflowId: 'wf-1',
        repoFullName: 'acme/widgets',
        name: 'CI',
        totalRuns: 0,
        failedRuns: 0,
        jobs: [],
        failRate: 0,
        failRatePct: 0,
      },
    ]);
    expect(Number.isNaN(result[0].failRate)).toBe(false);
  });

  it('(4) computes exact failRate/failRatePct at workflow and job level across mixed conclusions', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { conclusion: 'success', jobs: [{ name: 'build', conclusion: 'success' }] },
            { conclusion: 'failure', jobs: [{ name: 'build', conclusion: 'failure' }] },
            { conclusion: 'timed_out', jobs: [{ name: 'build', conclusion: 'timed_out' }] },
            { conclusion: 'action_required', jobs: [{ name: 'build', conclusion: 'success' }] },
            { conclusion: 'success', jobs: [{ name: 'build', conclusion: 'success' }] },
            { conclusion: 'cancelled', jobs: [{ name: 'build', conclusion: 'cancelled' }] },
          ],
        },
      ],
    });

    const result = await getWorkflowFailRates('repo-1');

    // Workflow-level: 6 runs, failed = failure + timed_out + action_required = 3
    // (cancelled is NOT in FAILURE_CONCLUSIONS) -> failRate = 3/6 = 0.5 -> pct = 50
    // Job-level "build": 6 total, failed = failure + timed_out = 2 (its 3rd conclusion
    // is 'success' even though the run overall was action_required) -> rate = 2/6 = 0.3333...
    // -> pct = round(0.33333*1000)/10 = round(333.33)/10 = 333/10 = 33.3
    expect(result).toHaveLength(1);
    const wf = result[0];
    expect(wf.totalRuns).toBe(6);
    expect(wf.failedRuns).toBe(3);
    expect(wf.failRate).toBe(0.5);
    expect(wf.failRatePct).toBe(50);
    expect(wf.jobs).toEqual([
      {
        jobName: 'build',
        name: 'build',
        totalRuns: 6,
        failedRuns: 2,
        failRate: 2 / 6,
        failRatePct: 33.3,
      },
    ]);
  });
});

describe('getAllFailRates', () => {
  beforeEach(() => {
    repoFindUnique.mockReset();
    repoFindMany.mockReset();
  });

  it('(5) scopes repo lookup to userId and aggregates fail rates across all repos', async () => {
    repoFindMany.mockResolvedValue([{ id: 'repo-a' }, { id: 'repo-b' }]);
    repoFindUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'repo-a') {
        return Promise.resolve({
          fullName: 'acme/a',
          workflows: [{ id: 'wf-a', name: 'CI-A', runs: [{ conclusion: 'success', jobs: [] }] }],
        });
      }
      return Promise.resolve({
        fullName: 'acme/b',
        workflows: [{ id: 'wf-b', name: 'CI-B', runs: [{ conclusion: 'failure', jobs: [] }] }],
      });
    });

    const result = await getAllFailRates('user-1', 30);

    expect(repoFindMany).toHaveBeenCalledWith({ where: { userId: 'user-1' }, select: { id: true } });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.workflowId)).toEqual(['wf-a', 'wf-b']);
    expect(result[0].failRatePct).toBe(0);
    expect(result[1].failRatePct).toBe(100);
  });

  it('(6) returns [] when the user has no repos', async () => {
    repoFindMany.mockResolvedValue([]);

    const result = await getAllFailRates('user-empty', 30);

    expect(result).toEqual([]);
    expect(repoFindUnique).not.toHaveBeenCalled();
  });
});

describe('getWorkflowFailRateMultiPeriod', () => {
  beforeEach(() => {
    workflowFindFirst.mockReset();
    workflowRunFindMany.mockReset();
  });

  it('(7) throws when the workflow is not found, or does not belong to userId (fail-closed)', async () => {
    workflowFindFirst.mockResolvedValue(null);

    await expect(getWorkflowFailRateMultiPeriod('wf-x', 'user-1')).rejects.toThrow('Workflow wf-x not found');
    expect(workflowFindFirst).toHaveBeenCalledWith({
      where: { id: 'wf-x', repo: { userId: 'user-1' } },
      include: { repo: true },
    });
  });

  it('(8) computes exact failRate/failRatePct independently for each of the 1/7/30 day periods', async () => {
    workflowFindFirst.mockResolvedValue({
      id: 'wf-1',
      name: 'CI',
      repo: { fullName: 'acme/widgets' },
    });
    // Return progressively larger run sets as the "since" window widens with period,
    // matching how a real DB query would behave for a real time window.
    workflowRunFindMany.mockImplementation(({ where }: { where: { workflowId: string; runCreatedAt: unknown } }) => {
      void where;
      // Distinguish calls by call order: 1d -> 7d -> 30d (periods array order).
      const callIndex = workflowRunFindMany.mock.calls.length - 1;
      const runSets = [
        [{ conclusion: 'success' }], // period=1: 1 run, 0 failed
        [{ conclusion: 'success' }, { conclusion: 'failure' }, { conclusion: 'success' }], // period=7: 3 runs, 1 failed
        [
          { conclusion: 'success' },
          { conclusion: 'failure' },
          { conclusion: 'failure' },
          { conclusion: 'success' },
        ], // period=30: 4 runs, 2 failed
      ];
      return Promise.resolve(runSets[callIndex]);
    });

    const result = await getWorkflowFailRateMultiPeriod('wf-1', 'user-1');

    expect(result[1]).toEqual({
      workflowId: 'wf-1',
      repoFullName: 'acme/widgets',
      name: 'CI',
      totalRuns: 1,
      failedRuns: 0,
      failRate: 0,
      failRatePct: 0,
    });
    expect(result[7]).toEqual({
      workflowId: 'wf-1',
      repoFullName: 'acme/widgets',
      name: 'CI',
      totalRuns: 3,
      failedRuns: 1,
      failRate: 1 / 3,
      failRatePct: 33.3,
    });
    expect(result[30]).toEqual({
      workflowId: 'wf-1',
      repoFullName: 'acme/widgets',
      name: 'CI',
      totalRuns: 4,
      failedRuns: 2,
      failRate: 0.5,
      failRatePct: 50,
    });
    expect(workflowRunFindMany).toHaveBeenCalledTimes(3);
    expect(workflowRunFindMany).toHaveBeenNthCalledWith(1, {
      where: { workflowId: 'wf-1', runCreatedAt: { gte: expect.any(Date) } },
      select: { conclusion: true },
    });
  });
});
