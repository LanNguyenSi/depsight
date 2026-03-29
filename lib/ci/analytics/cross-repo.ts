import { prisma } from "@/lib/prisma";
import { getWorkflowBuildTimes } from "./build-times";
import { getBottlenecks } from "./bottleneck";
import type { Period } from "./fail-rate";

export interface RepoHealthSummary {
  repoId: string;
  repoFullName: string;
  owner: string;
  name: string;
  lastScannedAt: Date | null;
  period: Period;
  totalWorkflows: number;
  totalRunsInPeriod: number;
  overallFailRatePct: number;
  avgBuildTimeMs: number | null;
  p95BuildTimeMs: number | null;
  flakyJobCount: number;
  topBottleneck: string | null;
  ciHealthScore: number; // 0–100
  ciHealthStatus: "healthy" | "warning" | "critical";
}

export async function getCIRepoHealthSummary(
  repoFullName: string,
  period: Period = 30
): Promise<RepoHealthSummary | null> {
  const since = new Date();
  since.setDate(since.getDate() - period);

  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName },
    include: {
      _count: { select: { workflows: true } },
      workflows: {
        include: {
          runs: {
            where: { runCreatedAt: { gte: since }, status: "completed" },
            select: { conclusion: true, durationMs: true },
          },
        },
      },
    },
  });

  if (!repo) return null;

  let totalRuns = 0;
  let failedRuns = 0;
  const allDurations: number[] = [];

  for (const wf of repo.workflows) {
    for (const run of wf.runs) {
      totalRuns++;
      if (run.conclusion && ["failure", "timed_out", "action_required"].includes(run.conclusion)) {
        failedRuns++;
      }
      if (run.durationMs != null) allDurations.push(run.durationMs);
    }
  }

  const overallFailRatePct = totalRuns > 0
    ? Math.round((failedRuns / totalRuns) * 1000) / 10
    : 0;

  const buildTimes = await getWorkflowBuildTimes(repoFullName, period);
  const allP95 = buildTimes.map((b) => b.overall.p95).filter((v): v is number => v !== null);
  const avgBuildTimeMs = allDurations.length > 0
    ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
    : null;
  const p95BuildTimeMs = allP95.length > 0
    ? Math.round(allP95.reduce((a, b) => a + b, 0) / allP95.length)
    : null;

  const bottlenecks = await getBottlenecks(repoFullName, period);
  const topBottleneck = bottlenecks.find((b) => b.rank === 1)?.jobName ?? null;

  const failPenalty = Math.min(40, overallFailRatePct * 0.8);
  const slowPenalty = p95BuildTimeMs != null
    ? Math.min(30, (p95BuildTimeMs / 600000) * 30)
    : 0;
  const ciHealthScore = Math.max(0, Math.round(100 - failPenalty - slowPenalty));
  const ciHealthStatus: RepoHealthSummary["ciHealthStatus"] =
    ciHealthScore >= 70 ? "healthy" : ciHealthScore >= 40 ? "warning" : "critical";

  return {
    repoId: repo.id,
    repoFullName,
    owner: repo.owner,
    name: repo.name,
    lastScannedAt: repo.lastScannedAt,
    period,
    totalWorkflows: repo._count.workflows,
    totalRunsInPeriod: totalRuns,
    overallFailRatePct,
    avgBuildTimeMs,
    p95BuildTimeMs,
    flakyJobCount: 0,
    topBottleneck,
    ciHealthScore,
    ciHealthStatus,
  };
}

export async function getAllCIHealthSummaries(
  userId: string,
  period: Period = 30
): Promise<RepoHealthSummary[]> {
  const repos = await prisma.repo.findMany({
    where: { userId, tracked: true },
    select: { fullName: true },
  });

  const summaries = await Promise.all(
    repos.map((r) => getCIRepoHealthSummary(r.fullName, period))
  );

  return summaries
    .filter((s): s is RepoHealthSummary => s !== null)
    .sort((a, b) => a.ciHealthScore - b.ciHealthScore);
}
