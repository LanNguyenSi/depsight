// Unit tests for lib/ci/analytics/flaky.ts
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import module last.
// Covers detectFlakyJobs: the minRuns threshold guard, the high-fail-rate signal,
// the sha-retry signal, the combined "both" signal + sort order, and exact
// prisma call args (scoping + since-date window).
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
import { detectFlakyJobs } from '@/lib/ci/analytics/flaky';

describe('detectFlakyJobs', () => {
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

    const result = await detectFlakyJobs('repo-missing');

    expect(result).toEqual([]);
  });

  it('(2) scopes the query to repoId, status=completed, and the exact since-date window (default period=30)', async () => {
    repoFindUnique.mockResolvedValue(null);

    await detectFlakyJobs('repo-42');

    const expectedSince = new Date(FIXED_NOW);
    expectedSince.setDate(expectedSince.getDate() - 30);

    expect(repoFindUnique).toHaveBeenCalledWith({
      where: { id: 'repo-42' },
      include: {
        workflows: {
          include: {
            runs: {
              where: { runCreatedAt: { gte: expectedSince }, status: 'completed' },
              select: {
                headSha: true,
                jobs: { select: { name: true, conclusion: true } },
              },
            },
          },
        },
      },
    });
  });

  it('(3) skips jobs below minRuns even if every run failed (data.total < minRuns guard)', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { headSha: 'sha1', jobs: [{ name: 'build', conclusion: 'failure' }] },
            { headSha: 'sha2', jobs: [{ name: 'build', conclusion: 'failure' }] },
            { headSha: 'sha3', jobs: [{ name: 'build', conclusion: 'failure' }] },
          ],
        },
      ],
    });

    // default MIN_RUNS_FOR_DETECTION = 5, only 3 runs supplied
    const result = await detectFlakyJobs('repo-1');

    expect(result).toEqual([]);
  });

  it('(4) flags high-fail-rate signal with exact failRatePct once minRuns is met and rate exceeds threshold', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { headSha: 'sha1', jobs: [{ name: 'build', conclusion: 'success' }] },
            { headSha: 'sha2', jobs: [{ name: 'build', conclusion: 'success' }] },
            { headSha: 'sha3', jobs: [{ name: 'build', conclusion: 'failure' }] },
            { headSha: 'sha4', jobs: [{ name: 'build', conclusion: 'failure' }] },
            { headSha: 'sha5', jobs: [{ name: 'build', conclusion: 'success' }] },
          ],
        },
      ],
    });

    // total=5, failed=2, failRate=0.4 > default threshold 0.2 -> high-fail-rate.
    // No SHA has mixed conclusions (each SHA appears once) -> shaRetryCount=0.
    const result = await detectFlakyJobs('repo-1');

    expect(result).toEqual([
      {
        jobName: 'build',
        workflowId: 'wf-1',
        workflowName: 'CI',
        repoFullName: 'acme/widgets',
        signal: 'high-fail-rate',
        totalRuns: 5,
        failedRuns: 2,
        failRatePct: 40,
        shaRetryCount: 0,
        shaRetryExamples: [],
      },
    ]);
  });

  it('(5) flags sha-retry signal when a SHA has both success and failure conclusions, even under threshold', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { headSha: 'deadbeef01', jobs: [{ name: 'test', conclusion: 'failure' }] },
            { headSha: 'deadbeef01', jobs: [{ name: 'test', conclusion: 'success' }] },
            { headSha: 'sha3', jobs: [{ name: 'test', conclusion: 'success' }] },
            { headSha: 'sha4', jobs: [{ name: 'test', conclusion: 'success' }] },
            { headSha: 'sha5', jobs: [{ name: 'test', conclusion: 'success' }] },
          ],
        },
      ],
    });

    // total=5, failed=1, failRate=0.2, NOT > threshold 0.2 (strict >) -> not high-fail-rate.
    // deadbeef01 has both success and failure -> sha-retry.
    const result = await detectFlakyJobs('repo-1');

    expect(result).toEqual([
      {
        jobName: 'test',
        workflowId: 'wf-1',
        workflowName: 'CI',
        repoFullName: 'acme/widgets',
        signal: 'sha-retry',
        totalRuns: 5,
        failedRuns: 1,
        failRatePct: 20,
        shaRetryCount: 1,
        shaRetryExamples: ['deadbeef'],
      },
    ]);
  });

  it('(6) flags combined "both" signal and sorts "both" ahead of single-signal jobs, then by failRatePct desc', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            // "flakyboth": high fail rate AND sha-retry
            { headSha: 'shaA', jobs: [{ name: 'flakyboth', conclusion: 'failure' }] },
            { headSha: 'shaA', jobs: [{ name: 'flakyboth', conclusion: 'success' }] },
            { headSha: 'shaB', jobs: [{ name: 'flakyboth', conclusion: 'failure' }] },
            { headSha: 'shaC', jobs: [{ name: 'flakyboth', conclusion: 'failure' }] },
            { headSha: 'shaD', jobs: [{ name: 'flakyboth', conclusion: 'success' }] },
            // "onlyhigh": high fail rate only, no mixed SHA, but higher failRatePct than flakyboth
            { headSha: 'shaE', jobs: [{ name: 'onlyhigh', conclusion: 'failure' }] },
            { headSha: 'shaF', jobs: [{ name: 'onlyhigh', conclusion: 'failure' }] },
            { headSha: 'shaG', jobs: [{ name: 'onlyhigh', conclusion: 'failure' }] },
            { headSha: 'shaH', jobs: [{ name: 'onlyhigh', conclusion: 'failure' }] },
            { headSha: 'shaI', jobs: [{ name: 'onlyhigh', conclusion: 'success' }] },
          ],
        },
      ],
    });

    const result = await detectFlakyJobs('repo-1');

    // flakyboth: total=5 failed=3 -> failRatePct=60, isHighFailRate=true; shaA has failure+success -> sha-retry=true -> "both"
    // onlyhigh: total=5 failed=4 -> failRatePct=80, isHighFailRate=true; no mixed SHA -> "high-fail-rate"
    // Even though onlyhigh has a higher failRatePct, "both" must sort first.
    expect(result.map((j) => j.jobName)).toEqual(['flakyboth', 'onlyhigh']);
    expect(result[0].signal).toBe('both');
    expect(result[0].failRatePct).toBe(60);
    expect(result[1].signal).toBe('high-fail-rate');
    expect(result[1].failRatePct).toBe(80);
  });

  it('(7) respects custom options (period, failRateThreshold, minRuns)', async () => {
    repoFindUnique.mockResolvedValue({
      fullName: 'acme/widgets',
      workflows: [
        {
          id: 'wf-1',
          name: 'CI',
          runs: [
            { headSha: 'sha1', jobs: [{ name: 'build', conclusion: 'success' }] },
            { headSha: 'sha2', jobs: [{ name: 'build', conclusion: 'failure' }] },
          ],
        },
      ],
    });

    // minRuns=2 (default 5 would have skipped this); threshold=0.1 so a single
    // failure out of 2 (rate 0.5) exceeds it and is flagged despite few samples.
    const result = await detectFlakyJobs('repo-1', { period: 7, minRuns: 2, failRateThreshold: 0.1 });

    expect(result).toHaveLength(1);
    expect(result[0].totalRuns).toBe(2);
    expect(result[0].failedRuns).toBe(1);
    expect(result[0].failRatePct).toBe(50);
    expect(result[0].signal).toBe('high-fail-rate');
  });
});
