import { prisma } from '@/lib/prisma';
import { ingestRepo } from './ingest';
import type { IngestionResult } from './github/types';

export interface SyncOptions {
  daysBack?: number;
  maxRunsPerWorkflow?: number;
  fetchJobs?: boolean;
}

export interface SyncSummary {
  reposAttempted: number;
  reposSucceeded: number;
  reposFailed: number;
  totalRunsIngested: number;
  totalRunsSkipped: number;
  totalJobsIngested: number;
  errors: { repo: string; error: string }[];
  results: IngestionResult[];
  durationMs: number;
}

/**
 * Sync a single repo by its depsight repoId.
 */
export async function syncRepoById(
  repoId: string,
  options: SyncOptions = {}
): Promise<IngestionResult> {
  const since = options.daysBack
    ? new Date(Date.now() - options.daysBack * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default 30 days

  return ingestRepo(repoId, {
    since,
    maxRunsPerWorkflow: options.maxRunsPerWorkflow ?? 100,
    fetchJobs: options.fetchJobs ?? true,
  });
}

/**
 * Sync all tracked repos for a user.
 */
export async function syncAllUserRepos(
  userId: string,
  options: SyncOptions = {}
): Promise<SyncSummary> {
  const startMs = Date.now();
  const summary: SyncSummary = {
    reposAttempted: 0,
    reposSucceeded: 0,
    reposFailed: 0,
    totalRunsIngested: 0,
    totalRunsSkipped: 0,
    totalJobsIngested: 0,
    errors: [],
    results: [],
    durationMs: 0,
  };

  const repos = await prisma.repo.findMany({
    where: { userId, tracked: true },
    select: { id: true, fullName: true },
  });

  summary.reposAttempted = repos.length;

  const CONCURRENCY = 3;
  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((r) => syncRepoById(r.id, options))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const repo = batch[j];
      if (result.status === 'fulfilled') {
        summary.reposSucceeded++;
        summary.totalRunsIngested += result.value.runsIngested;
        summary.totalRunsSkipped += result.value.runsSkipped;
        summary.totalJobsIngested += result.value.jobsIngested;
        summary.results.push(result.value);
        if (result.value.errors.length > 0) {
          summary.errors.push(...result.value.errors.map((e) => ({ repo: repo.fullName, error: e })));
        }
      } else {
        summary.reposFailed++;
        summary.errors.push({
          repo: repo.fullName,
          error: result.reason?.message ?? 'Unknown error',
        });
      }
    }
  }

  summary.durationMs = Date.now() - startMs;
  return summary;
}
