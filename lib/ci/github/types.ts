export interface GitHubWorkflowRun {
  id: number;
  run_number: number;
  workflow_id: number;
  name: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  head_commit_message: string | null;
  run_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  runner_name: string | null;
  steps: GitHubStep[];
}

export interface GitHubStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface IngestionResult {
  repoFullName: string;
  workflowsProcessed: number;
  runsIngested: number;
  runsSkipped: number;
  jobsIngested: number;
  errors: string[];
}
