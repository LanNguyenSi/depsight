// Unit tests for lib/ci/ingest.ts (ingestRepo).
// PATTERN B: hoisted mock handles, vi.mock() before imports, import module last.
//
// ingestRepo's direct GitHub dependency is the wrapper module
// lib/ci/github/workflows.ts (listWorkflows/listWorkflowRuns/listJobsForRun),
// which is what gets mocked here (one layer down from the file under test,
// matching the Pattern B idiom used by the route tests). The literal Octokit
// per_page/cursor HTTP pagination lives inside that wrapper module, which is
// NOT in this task's Scope list — it is exercised here only through the
// `since`/`maxRuns` options ingestRepo passes down to it, and through the
// empty-array/"last page" termination behavior at the call-site.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  repoFindUnique,
  workflowUpsert,
  workflowRunFindUnique,
  workflowRunCreate,
  jobRunCreate,
  listWorkflowsMock,
  listWorkflowRunsMock,
  listJobsForRunMock,
} = vi.hoisted(() => ({
  repoFindUnique: vi.fn(),
  workflowUpsert: vi.fn(),
  workflowRunFindUnique: vi.fn(),
  workflowRunCreate: vi.fn(),
  jobRunCreate: vi.fn(),
  listWorkflowsMock: vi.fn(),
  listWorkflowRunsMock: vi.fn(),
  listJobsForRunMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findUnique: repoFindUnique },
    workflow: { upsert: workflowUpsert },
    workflowRun: { findUnique: workflowRunFindUnique, create: workflowRunCreate },
    jobRun: { create: jobRunCreate },
  },
}));
vi.mock('@/lib/ci/github/workflows', () => ({
  listWorkflows: listWorkflowsMock,
  listWorkflowRuns: listWorkflowRunsMock,
  listJobsForRun: listJobsForRunMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { ingestRepo } from '@/lib/ci/ingest';

const REPO_ROW = {
  id: 'repo-1',
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  user: { githubToken: 'tok-abc' },
};

const WORKFLOW = { id: 10, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };

function makeRun(overrides: Partial<{ id: number; run_started_at: string | null; updated_at: string }> = {}) {
  return {
    id: overrides.id ?? 1,
    run_number: 1,
    workflow_id: WORKFLOW.id,
    name: 'CI',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'abc123',
    head_commit_message: 'fix: bug',
    run_started_at: overrides.run_started_at ?? '2026-06-30T10:00:00Z',
    created_at: '2026-06-30T10:00:00Z',
    updated_at: overrides.updated_at ?? '2026-06-30T10:05:00Z',
  };
}

function makeJob(overrides: Partial<{ id: number }> = {}) {
  return {
    id: overrides.id ?? 100,
    run_id: 1,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-06-30T10:00:00Z',
    completed_at: '2026-06-30T10:03:00Z',
    runner_name: 'ubuntu-latest',
    steps: [],
  };
}

beforeEach(() => {
  repoFindUnique.mockReset();
  workflowUpsert.mockReset();
  workflowRunFindUnique.mockReset();
  workflowRunCreate.mockReset();
  jobRunCreate.mockReset();
  listWorkflowsMock.mockReset();
  listWorkflowRunsMock.mockReset();
  listJobsForRunMock.mockReset();

  repoFindUnique.mockResolvedValue(REPO_ROW);
  workflowUpsert.mockResolvedValue({ id: 'wf-db-1', repoId: 'repo-1', githubId: WORKFLOW.id });
  workflowRunFindUnique.mockResolvedValue(null);
  workflowRunCreate.mockResolvedValue({ id: 'run-db-1' });
  jobRunCreate.mockResolvedValue({ id: 'job-db-1' });
});

describe('ingestRepo — repo lookup', () => {
  it('throws when the repo does not exist', async () => {
    repoFindUnique.mockResolvedValue(null);

    await expect(ingestRepo('missing-repo')).rejects.toThrow('Repo missing-repo not found');
    expect(repoFindUnique).toHaveBeenCalledWith({
      where: { id: 'missing-repo' },
      include: { user: { select: { githubToken: true } } },
    });
  });
});

describe('ingestRepo — success path', () => {
  it('upserts the workflow with the exact dedup key and creates a new run with computed durationMs', async () => {
    listWorkflowsMock.mockResolvedValue([WORKFLOW]);
    listWorkflowRunsMock.mockResolvedValue([makeRun({ id: 55 })]);
    listJobsForRunMock.mockResolvedValue([]);

    const result = await ingestRepo('repo-1', { since: new Date('2026-06-01T00:00:00Z'), maxRunsPerWorkflow: 50 });

    expect(workflowUpsert).toHaveBeenCalledWith({
      where: { repoId_githubId: { repoId: 'repo-1', githubId: WORKFLOW.id } },
      create: { repoId: 'repo-1', githubId: WORKFLOW.id, name: WORKFLOW.name, path: WORKFLOW.path, state: WORKFLOW.state },
      update: { name: WORKFLOW.name, state: WORKFLOW.state },
    });

    expect(listWorkflowRunsMock).toHaveBeenCalledWith(
      'acme',
      'widgets',
      WORKFLOW.id,
      { since: new Date('2026-06-01T00:00:00Z'), maxRuns: 50 },
      'tok-abc',
    );

    expect(workflowRunFindUnique).toHaveBeenCalledWith({
      where: { githubRunId: BigInt(55) },
      select: { id: true },
    });

    expect(workflowRunCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: 'wf-db-1',
        githubRunId: BigInt(55),
        durationMs: 5 * 60 * 1000, // 10:00 -> 10:05
      }),
    });

    expect(result.runsIngested).toBe(1);
    expect(result.runsSkipped).toBe(0);
    expect(result.workflowsProcessed).toBe(1);
  });

  it('dedups an already-ingested run: workflowRun.findUnique hit skips create and increments runsSkipped', async () => {
    listWorkflowsMock.mockResolvedValue([WORKFLOW]);
    listWorkflowRunsMock.mockResolvedValue([makeRun({ id: 99 })]);
    workflowRunFindUnique.mockResolvedValue({ id: 'existing-run-db-id' });

    const result = await ingestRepo('repo-1');

    expect(result.runsSkipped).toBe(1);
    expect(result.runsIngested).toBe(0);
    expect(workflowRunCreate).not.toHaveBeenCalled();
    expect(listJobsForRunMock).not.toHaveBeenCalled();
  });

  it('fetches and creates jobs for a new run when fetchJobs is not explicitly false, with dedup-relevant githubJobId', async () => {
    listWorkflowsMock.mockResolvedValue([WORKFLOW]);
    listWorkflowRunsMock.mockResolvedValue([makeRun({ id: 7 })]);
    listJobsForRunMock.mockResolvedValue([makeJob({ id: 200 })]);

    const result = await ingestRepo('repo-1');

    expect(listJobsForRunMock).toHaveBeenCalledWith('acme', 'widgets', 7, 'tok-abc');
    expect(jobRunCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowRunId: 'run-db-1',
        githubJobId: BigInt(200),
        durationMs: 3 * 60 * 1000,
      }),
    });
    expect(result.jobsIngested).toBe(1);
  });

  it('fetchJobs:false skips job fetching entirely', async () => {
    listWorkflowsMock.mockResolvedValue([WORKFLOW]);
    listWorkflowRunsMock.mockResolvedValue([makeRun({ id: 8 })]);

    const result = await ingestRepo('repo-1', { fetchJobs: false });

    expect(listJobsForRunMock).not.toHaveBeenCalled();
    expect(result.jobsIngested).toBe(0);
  });

  it('an empty runs array for a workflow terminates that workflow\'s loop cleanly (no create calls)', async () => {
    listWorkflowsMock.mockResolvedValue([WORKFLOW]);
    listWorkflowRunsMock.mockResolvedValue([]);

    const result = await ingestRepo('repo-1');

    expect(workflowRunCreate).not.toHaveBeenCalled();
    expect(result.runsIngested).toBe(0);
    expect(result.runsSkipped).toBe(0);
  });
});

describe('ingestRepo — failure/edge branches', () => {
  it('listWorkflows failure records the error and returns immediately (workflowsProcessed stays 0)', async () => {
    listWorkflowsMock.mockRejectedValue(new Error('403 rate limited'));

    const result = await ingestRepo('repo-1');

    expect(result.workflowsProcessed).toBe(0);
    expect(result.errors).toEqual(['Failed to list workflows: 403 rate limited']);
    expect(workflowUpsert).not.toHaveBeenCalled();
  });

  it('a listWorkflowRuns failure for one workflow does not abort ingestion of the next workflow', async () => {
    const wf2 = { id: 20, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' };
    listWorkflowsMock.mockResolvedValue([WORKFLOW, wf2]);
    listWorkflowRunsMock
      .mockRejectedValueOnce(new Error('list runs failed'))
      .mockResolvedValueOnce([makeRun({ id: 33 })]);
    listJobsForRunMock.mockResolvedValue([]);
    workflowUpsert
      .mockResolvedValueOnce({ id: 'wf-db-1', repoId: 'repo-1', githubId: WORKFLOW.id })
      .mockResolvedValueOnce({ id: 'wf-db-2', repoId: 'repo-1', githubId: wf2.id });

    const result = await ingestRepo('repo-1');

    expect(result.workflowsProcessed).toBe(2);
    expect(result.errors).toEqual(['Workflow CI: failed to list runs: list runs failed']);
    // The second workflow's run still got ingested.
    expect(result.runsIngested).toBe(1);
  });

  it('a listJobsForRun failure for one run is recorded but does not abort ingestion (runsIngested still counts)', async () => {
    listWorkflowsMock.mockResolvedValue([WORKFLOW]);
    listWorkflowRunsMock.mockResolvedValue([makeRun({ id: 44 })]);
    listJobsForRunMock.mockRejectedValue(new Error('jobs API down'));

    const result = await ingestRepo('repo-1');

    expect(result.runsIngested).toBe(1);
    expect(result.errors).toEqual(['Run 44: failed to fetch jobs: jobs API down']);
    expect(jobRunCreate).not.toHaveBeenCalled();
  });
});
