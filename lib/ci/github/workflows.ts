import { Octokit } from '@octokit/rest';
import type { GitHubWorkflow, GitHubWorkflowRun, GitHubJob } from './types';

function getOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: 'depsight-ci/1.0' });
}

export async function listWorkflows(
  owner: string,
  repo: string,
  token: string
): Promise<GitHubWorkflow[]> {
  const octokit = getOctokit(token);
  const workflows: GitHubWorkflow[] = [];

  for await (const response of octokit.paginate.iterator(
    octokit.rest.actions.listRepoWorkflows,
    { owner, repo, per_page: 100 }
  )) {
    for (const w of response.data) {
      workflows.push({ id: w.id, name: w.name, path: w.path, state: w.state });
    }
  }

  return workflows;
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  workflowId: number,
  options: { since?: Date; maxRuns?: number } = {},
  token: string
): Promise<GitHubWorkflowRun[]> {
  const octokit = getOctokit(token);
  const runs: GitHubWorkflowRun[] = [];
  const maxRuns = options.maxRuns ?? 100;

  for await (const response of octokit.paginate.iterator(
    octokit.rest.actions.listWorkflowRuns,
    {
      owner,
      repo,
      workflow_id: workflowId,
      per_page: 100,
      created: options.since
        ? `>=${options.since.toISOString().split('T')[0]}`
        : undefined,
    }
  )) {
    for (const run of response.data) {
      if (runs.length >= maxRuns) break;
      runs.push({
        id: run.id,
        run_number: run.run_number,
        workflow_id: run.workflow_id,
        name: run.name ?? null,
        event: run.event,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        head_branch: run.head_branch ?? null,
        head_sha: run.head_sha,
        head_commit_message: run.head_commit?.message ?? null,
        run_started_at: run.run_started_at ?? null,
        created_at: run.created_at,
        updated_at: run.updated_at,
      });
    }
    if (runs.length >= maxRuns) break;
  }

  return runs;
}

export async function listJobsForRun(
  owner: string,
  repo: string,
  runId: number,
  token: string
): Promise<GitHubJob[]> {
  const octokit = getOctokit(token);
  const jobs: GitHubJob[] = [];

  for await (const response of octokit.paginate.iterator(
    octokit.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: runId, per_page: 100 }
  )) {
    for (const job of response.data) {
      jobs.push({
        id: job.id,
        run_id: runId,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion ?? null,
        started_at: job.started_at ?? null,
        completed_at: job.completed_at ?? null,
        runner_name: job.runner_name ?? null,
        steps: (job.steps ?? []).map((s) => ({
          name: s.name,
          status: s.status,
          conclusion: s.conclusion ?? null,
          number: s.number,
          started_at: s.started_at ?? null,
          completed_at: s.completed_at ?? null,
        })),
      });
    }
  }

  return jobs;
}
