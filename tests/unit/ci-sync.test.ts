// Unit tests for lib/ci/sync.ts (syncRepoById, syncAllUserRepos).
// PATTERN B: hoisted mock handles, vi.mock() before imports, import module last.
// Distinct from tests/unit/ci-sync-route.test.ts, which covers the
// app/api/ci/sync route handler with lib/ci/sync mocked away entirely.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { repoFindMany, ingestRepoMock } = vi.hoisted(() => ({
  repoFindMany: vi.fn(),
  ingestRepoMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: { repo: { findMany: repoFindMany } },
}));
vi.mock('@/lib/ci/ingest', () => ({ ingestRepo: ingestRepoMock }));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { syncRepoById, syncAllUserRepos } from '@/lib/ci/sync';

function makeIngestionResult(overrides: Partial<{
  runsIngested: number;
  runsSkipped: number;
  jobsIngested: number;
  errors: string[];
}> = {}) {
  return {
    repoFullName: 'acme/repo',
    workflowsProcessed: 1,
    runsIngested: overrides.runsIngested ?? 0,
    runsSkipped: overrides.runsSkipped ?? 0,
    jobsIngested: overrides.jobsIngested ?? 0,
    errors: overrides.errors ?? [],
  };
}

beforeEach(() => {
  repoFindMany.mockReset();
  ingestRepoMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// syncRepoById
// ---------------------------------------------------------------------------
describe('syncRepoById', () => {
  it('default options: computes `since` as 30 days back and passes maxRunsPerWorkflow=100, fetchJobs=true', async () => {
    const result = makeIngestionResult({ runsIngested: 5 });
    ingestRepoMock.mockResolvedValue(result);

    const value = await syncRepoById('repo-1');

    expect(value).toEqual(result);
    expect(ingestRepoMock).toHaveBeenCalledWith('repo-1', {
      since: new Date('2026-06-01T12:00:00Z'),
      maxRunsPerWorkflow: 100,
      fetchJobs: true,
    });
  });

  it('custom options: daysBack, maxRunsPerWorkflow, and fetchJobs=false are passed through exactly', async () => {
    ingestRepoMock.mockResolvedValue(makeIngestionResult());

    await syncRepoById('repo-2', { daysBack: 7, maxRunsPerWorkflow: 25, fetchJobs: false });

    expect(ingestRepoMock).toHaveBeenCalledWith('repo-2', {
      since: new Date('2026-06-24T12:00:00Z'),
      maxRunsPerWorkflow: 25,
      fetchJobs: false,
    });
  });

  it('propagates a rejection from ingestRepo unchanged (no swallowing)', async () => {
    ingestRepoMock.mockRejectedValue(new Error('GitHub rate limit exceeded'));

    await expect(syncRepoById('repo-3')).rejects.toThrow('GitHub rate limit exceeded');
  });
});

// ---------------------------------------------------------------------------
// syncAllUserRepos
// ---------------------------------------------------------------------------
describe('syncAllUserRepos', () => {
  it('queries repo.findMany scoped by userId + tracked:true, selecting id + fullName', async () => {
    repoFindMany.mockResolvedValue([]);

    await syncAllUserRepos('user-1');

    expect(repoFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', tracked: true },
      select: { id: true, fullName: true },
    });
  });

  it('aggregates successes: sums runsIngested/runsSkipped/jobsIngested across all repos', async () => {
    repoFindMany.mockResolvedValue([
      { id: 'r1', fullName: 'acme/r1' },
      { id: 'r2', fullName: 'acme/r2' },
    ]);
    ingestRepoMock
      .mockResolvedValueOnce(makeIngestionResult({ runsIngested: 3, runsSkipped: 1, jobsIngested: 6 }))
      .mockResolvedValueOnce(makeIngestionResult({ runsIngested: 2, runsSkipped: 0, jobsIngested: 4 }));

    const summary = await syncAllUserRepos('user-1');

    expect(summary.reposAttempted).toBe(2);
    expect(summary.reposSucceeded).toBe(2);
    expect(summary.reposFailed).toBe(0);
    expect(summary.totalRunsIngested).toBe(5);
    expect(summary.totalRunsSkipped).toBe(1);
    expect(summary.totalJobsIngested).toBe(10);
    expect(typeof summary.durationMs).toBe('number');
  });

  it('one repo failing does NOT abort the others — failed repo counted, others still succeed', async () => {
    repoFindMany.mockResolvedValue([
      { id: 'r1', fullName: 'acme/r1' },
      { id: 'r2', fullName: 'acme/r2' },
      { id: 'r3', fullName: 'acme/r3' },
    ]);
    ingestRepoMock
      .mockResolvedValueOnce(makeIngestionResult({ runsIngested: 1 }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeIngestionResult({ runsIngested: 2 }));

    const summary = await syncAllUserRepos('user-1');

    expect(summary.reposAttempted).toBe(3);
    expect(summary.reposSucceeded).toBe(2);
    expect(summary.reposFailed).toBe(1);
    expect(summary.totalRunsIngested).toBe(3);
    expect(summary.errors).toEqual([{ repo: 'acme/r2', error: 'boom' }]);
  });

  it('a rejection with no .message falls back to "Unknown error"', async () => {
    repoFindMany.mockResolvedValue([{ id: 'r1', fullName: 'acme/r1' }]);
    ingestRepoMock.mockRejectedValueOnce('non-error-reason');

    const summary = await syncAllUserRepos('user-1');

    expect(summary.errors).toEqual([{ repo: 'acme/r1', error: 'Unknown error' }]);
  });

  it('collects per-repo partial errors from a successful (non-rejected) ingestion result', async () => {
    repoFindMany.mockResolvedValue([{ id: 'r1', fullName: 'acme/r1' }]);
    ingestRepoMock.mockResolvedValueOnce(
      makeIngestionResult({ errors: ['Workflow x: failed to list runs: 500'] }),
    );

    const summary = await syncAllUserRepos('user-1');

    expect(summary.reposSucceeded).toBe(1);
    expect(summary.errors).toEqual([{ repo: 'acme/r1', error: 'Workflow x: failed to list runs: 500' }]);
  });

  it('passes the same options through to every syncRepoById call (via ingestRepo since-date)', async () => {
    repoFindMany.mockResolvedValue([{ id: 'r1', fullName: 'acme/r1' }]);
    ingestRepoMock.mockResolvedValue(makeIngestionResult());

    await syncAllUserRepos('user-1', { daysBack: 1 });

    expect(ingestRepoMock).toHaveBeenCalledWith('r1', {
      since: new Date('2026-06-30T12:00:00Z'),
      maxRunsPerWorkflow: 100,
      fetchJobs: true,
    });
  });
});
