import { prisma } from "@/lib/prisma";
import type { Period } from "./fail-rate";

export interface Percentiles {
  p50: number | null; // median, ms
  p95: number | null; // 95th percentile, ms
  min: number | null;
  max: number | null;
  avg: number | null;
  sampleSize: number;
}

export interface WorkflowBuildTimes {
  workflowId: string;
  repoFullName: string;
  name: string;
  overall: Percentiles;
  byBranch: Record<string, Percentiles>;
  jobs: JobBuildTimes[];
}

export interface JobBuildTimes {
  jobName: string;
  percentiles: Percentiles;
}

/** Compute percentile from a sorted array of numbers */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  // linear interpolation
  return sorted[lower] + (idx - lower) * (sorted[upper] - sorted[lower]);
}

function computePercentiles(values: number[]): Percentiles {
  if (values.length === 0) {
    return { p50: null, p95: null, min: null, max: null, avg: null, sampleSize: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    p50: Math.round(percentile(sorted, 50)!),
    p95: Math.round(percentile(sorted, 95)!),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    sampleSize: sorted.length,
  };
}

/**
 * Get P50/P95 build times for all workflows in a repo.
 * Includes per-branch and per-job breakdown.
 */
export async function getWorkflowBuildTimes(
  repoFullName: string,
  period: Period = 30
): Promise<WorkflowBuildTimes[]> {
  const since = new Date();
  since.setDate(since.getDate() - period);

  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName },
    include: {
      workflows: {
        include: {
          runs: {
            where: {
              runCreatedAt: { gte: since },
              durationMs: { not: null },
              status: "completed",
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

  if (!repo) return [];

  return repo.workflows.map((wf) => {
    const runs = wf.runs;

    // Overall percentiles
    const allDurations = runs.map((r) => r.durationMs!).filter(Boolean);
    const overall = computePercentiles(allDurations);

    // Per-branch percentiles
    const branchMap = new Map<string, number[]>();
    for (const run of runs) {
      if (!run.headBranch || run.durationMs == null) continue;
      const arr = branchMap.get(run.headBranch) ?? [];
      arr.push(run.durationMs);
      branchMap.set(run.headBranch, arr);
    }
    const byBranch: Record<string, Percentiles> = {};
    for (const [branch, durations] of branchMap.entries()) {
      byBranch[branch] = computePercentiles(durations);
    }

    // Per-job percentiles
    const jobMap = new Map<string, number[]>();
    for (const run of runs) {
      for (const job of run.jobs) {
        if (job.durationMs == null) continue;
        const arr = jobMap.get(job.name) ?? [];
        arr.push(job.durationMs);
        jobMap.set(job.name, arr);
      }
    }
    const jobs: JobBuildTimes[] = Array.from(jobMap.entries()).map(([name, durations]) => ({
      jobName: name,
      percentiles: computePercentiles(durations),
    }));

    return {
      workflowId: wf.id,
      repoFullName,
      name: wf.name,
      overall,
      byBranch,
      jobs,
    };
  });
}
