import { prisma } from "@/lib/prisma";
import type { Period } from "./fail-rate";

export interface JobBottleneck {
  jobName: string;
  workflowId: string;
  workflowName: string;
  repoFullName: string;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  sampleSize: number;
  /** Share of total workflow duration this job accounts for (0–1) */
  durationShare: number;
  rank: number; // 1 = slowest
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function p95(sorted: number[]): number {
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Identify job bottlenecks per workflow for a repo.
 * Returns jobs ranked by average duration (slowest first).
 */
export async function getBottlenecks(
  repoFullName: string,
  period: Period = 30
): Promise<JobBottleneck[]> {
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
              status: "completed",
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

  if (!repo) return [];

  const results: JobBottleneck[] = [];

  for (const wf of repo.workflows) {
    const jobMap = new Map<string, number[]>();

    for (const run of wf.runs) {
      for (const job of run.jobs) {
        if (job.durationMs == null) continue;
        const arr = jobMap.get(job.name) ?? [];
        arr.push(job.durationMs);
        jobMap.set(job.name, arr);
      }
    }

    if (jobMap.size === 0) continue;

    // Compute avg per job + total avg for share calculation
    const jobAvgs: { name: string; avg: number }[] = [];
    for (const [name, durations] of jobMap.entries()) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      jobAvgs.push({ name, avg });
    }
    const totalAvgMs = jobAvgs.reduce((a, j) => a + j.avg, 0);

    // Build results sorted by avg desc
    const sorted = [...jobAvgs].sort((a, b) => b.avg - a.avg);

    sorted.forEach((j, idx) => {
      const durations = [...(jobMap.get(j.name) ?? [])].sort((a, b) => a - b);
      results.push({
        jobName: j.name,
        workflowId: wf.id,
        workflowName: wf.name,
        repoFullName,
        avgDurationMs: Math.round(j.avg),
        p50DurationMs: median(durations),
        p95DurationMs: p95(durations),
        sampleSize: durations.length,
        durationShare: totalAvgMs > 0 ? Math.round((j.avg / totalAvgMs) * 1000) / 1000 : 0,
        rank: idx + 1,
      });
    });
  }

  return results;
}
