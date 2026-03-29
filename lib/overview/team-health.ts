import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface RepoHealthSummary {
  repoId: string;
  fullName: string;
  owner: string;
  name: string;
  language: string | null;
  lastScannedAt: Date | null;
  riskScore: number;
  cveCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  licenseIssues: number;
  outdatedDeps: number;
  totalDeps: number;
  healthScore: number; // 0-100, higher is better
}

export interface TeamHealthOverview {
  repos: RepoHealthSummary[];
  aggregate: {
    totalRepos: number;
    scannedRepos: number;
    avgRiskScore: number;
    totalCVEs: number;
    totalCritical: number;
    totalHigh: number;
    totalLicenseIssues: number;
    highRiskRepos: number;   // riskScore >= 70
    mediumRiskRepos: number; // riskScore 40-69
    lowRiskRepos: number;    // riskScore < 40
    overallHealthScore: number;
  };
  topRiskyRepos: RepoHealthSummary[];
  mostOutdated: RepoHealthSummary[];
}

function calcHealthScore(
  repo: Pick<RepoHealthSummary, 'riskScore' | 'licenseIssues' | 'outdatedDeps' | 'totalDeps'>,
  ciPenalty: number = 0
): number {
  // Health = inverse risk + license health + dep freshness + CI health
  const riskPenalty = repo.riskScore; // 0-100, lower risk = higher health
  const licensePenalty = Math.min(repo.licenseIssues * 5, 20); // max 20 points penalty
  const depPenalty = repo.totalDeps > 0
    ? Math.min((repo.outdatedDeps / repo.totalDeps) * 30, 30) // max 30 points penalty
    : 0;

  // ciPenalty: fail rate > 20% = -10, flaky jobs = -5 each (max -20), build P95 > 15min = -5
  const raw = 100 - riskPenalty * 0.5 - licensePenalty - depPenalty - ciPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export async function getTeamHealthOverview(userId: string): Promise<TeamHealthOverview> {
  const repos = await prisma.repo.findMany({
    where: { userId, tracked: true },
    orderBy: { updatedAt: 'desc' },
  });

  // Get latest CVE scan per repo (for risk scores)
  const cveScansByRepo = new Map<string, {
    riskScore: number; cveCount: number; criticalCount: number;
    highCount: number; mediumCount: number; lowCount: number;
  }>();
  const cveScans = await prisma.scan.findMany({
    where: {
      repo: { userId, tracked: true },
      status: 'COMPLETED',
      cvePayload: { not: Prisma.DbNull },
    },
    orderBy: { scannedAt: 'desc' },
    distinct: ['repoId'],
    select: {
      repoId: true, riskScore: true, cveCount: true,
      criticalCount: true, highCount: true, mediumCount: true, lowCount: true,
    },
  });
  for (const s of cveScans) {
    cveScansByRepo.set(s.repoId, s);
  }

  // Get latest license scan per repo
  const licenseScansByRepo = new Map<string, { licenseIssues: number }>();
  const licenseScans = await prisma.scan.findMany({
    where: {
      repo: { userId, tracked: true },
      status: 'COMPLETED',
      licenseCount: { gt: 0 },
    },
    orderBy: { scannedAt: 'desc' },
    distinct: ['repoId'],
    select: { repoId: true, licenseIssues: true },
  });
  for (const s of licenseScans) {
    licenseScansByRepo.set(s.repoId, s);
  }

  // Get latest deps scan per repo
  const depsScansByRepo = new Map<string, { scanId: string; depCount: number }>();
  const depsScans = await prisma.scan.findMany({
    where: {
      repo: { userId, tracked: true },
      status: 'COMPLETED',
      dependencies: { some: {} },
    },
    orderBy: { scannedAt: 'desc' },
    distinct: ['repoId'],
    select: { id: true, repoId: true, _count: { select: { dependencies: true } } },
  });
  for (const s of depsScans) {
    depsScansByRepo.set(s.repoId, { scanId: s.id, depCount: s._count.dependencies });
  }

  // Get outdated dep counts per repo's deps scan
  const outdatedByScanId = new Map<string, number>();
  const depsScanIds = [...depsScansByRepo.values()].map((d) => d.scanId);
  if (depsScanIds.length > 0) {
    const outdatedCounts = await prisma.dependency.groupBy({
      by: ['scanId'],
      where: {
        scanId: { in: depsScanIds },
        status: { in: ['OUTDATED', 'MAJOR_BEHIND', 'DEPRECATED'] },
      },
      _count: true,
    });
    for (const r of outdatedCounts) {
      outdatedByScanId.set(r.scanId, r._count);
    }
  }

  // Fetch CI penalties for all repos in parallel (graceful — returns 0 if no CI data)
  const ciPenalties = await Promise.all(
    repos.map((repo) => getCIPenalty(repo.fullName))
  );
  const ciPenaltyByRepoId = new Map<string, number>(
    repos.map((repo, i) => [repo.id, ciPenalties[i]])
  );

  const summaries: RepoHealthSummary[] = repos.map((repo) => {
    const cveScan = cveScansByRepo.get(repo.id);
    const licenseScan = licenseScansByRepo.get(repo.id);
    const depsScan = depsScansByRepo.get(repo.id);
    const outdated = depsScan ? (outdatedByScanId.get(depsScan.scanId) ?? 0) : 0;
    const totalDeps = depsScan?.depCount ?? 0;
    const ciPenalty = ciPenaltyByRepoId.get(repo.id) ?? 0;

    const summary: RepoHealthSummary = {
      repoId: repo.id,
      fullName: repo.fullName,
      owner: repo.owner,
      name: repo.name,
      language: repo.language,
      lastScannedAt: repo.lastScannedAt,
      riskScore: cveScan?.riskScore ?? 0,
      cveCount: cveScan?.cveCount ?? 0,
      criticalCount: cveScan?.criticalCount ?? 0,
      highCount: cveScan?.highCount ?? 0,
      mediumCount: cveScan?.mediumCount ?? 0,
      lowCount: cveScan?.lowCount ?? 0,
      licenseIssues: licenseScan?.licenseIssues ?? 0,
      outdatedDeps: outdated,
      totalDeps,
      healthScore: 0,
    };
    summary.healthScore = calcHealthScore(summary, ciPenalty);
    return summary;
  });

  // Aggregate
  const scanned = summaries.filter((r) => r.lastScannedAt !== null);
  const aggregate = {
    totalRepos: summaries.length,
    scannedRepos: scanned.length,
    avgRiskScore: scanned.length > 0
      ? Math.round(scanned.reduce((s, r) => s + r.riskScore, 0) / scanned.length)
      : 0,
    totalCVEs: summaries.reduce((s, r) => s + r.cveCount, 0),
    totalCritical: summaries.reduce((s, r) => s + r.criticalCount, 0),
    totalHigh: summaries.reduce((s, r) => s + r.highCount, 0),
    totalLicenseIssues: summaries.reduce((s, r) => s + r.licenseIssues, 0),
    highRiskRepos: scanned.filter((r) => r.riskScore >= 70).length,
    mediumRiskRepos: scanned.filter((r) => r.riskScore >= 40 && r.riskScore < 70).length,
    lowRiskRepos: scanned.filter((r) => r.riskScore < 40).length,
    overallHealthScore: scanned.length > 0
      ? Math.round(scanned.reduce((s, r) => s + r.healthScore, 0) / scanned.length)
      : 100,
  };

  const topRiskyRepos = [...summaries]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);

  const mostOutdated = [...summaries]
    .filter((r) => r.totalDeps > 0)
    .sort((a, b) => (b.outdatedDeps / Math.max(b.totalDeps, 1)) - (a.outdatedDeps / Math.max(a.totalDeps, 1)))
    .slice(0, 5);

  return { repos: summaries, aggregate, topRiskyRepos, mostOutdated };
}

/**
 * Calculate CI health penalty for team health score.
 * - Fail rate > 20% → -10 points
 * - Each flaky job → -5 points (max -20)
 * - Build P95 > 15min → -5 points
 */
export async function getCIPenalty(repoFullName: string): Promise<number> {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const repo = await prisma.repo.findFirst({
      where: { fullName: repoFullName },
      include: {
        workflows: {
          include: {
            runs: {
              where: { runCreatedAt: { gte: since30d }, status: 'completed' },
              select: { conclusion: true, durationMs: true, jobs: { select: { name: true, conclusion: true } } },
            },
          },
        },
      },
    });

    if (!repo || !repo.workflows.length) return 0;

    let totalRuns = 0;
    let failedRuns = 0;
    const allP95s: number[] = [];
    const jobFailMap = new Map<string, { total: number; failed: number }>();

    const FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'action_required'];

    for (const wf of repo.workflows) {
      const durations = wf.runs.map((r) => r.durationMs).filter((d): d is number => d != null).sort((a, b) => a - b);
      if (durations.length > 0) {
        const p95idx = Math.ceil(0.95 * durations.length) - 1;
        allP95s.push(durations[Math.max(0, p95idx)]);
      }
      for (const run of wf.runs) {
        totalRuns++;
        if (run.conclusion && FAILURE_CONCLUSIONS.includes(run.conclusion)) failedRuns++;
        for (const job of run.jobs) {
          if (!job.conclusion) continue;
          const entry = jobFailMap.get(job.name) ?? { total: 0, failed: 0 };
          entry.total++;
          if (FAILURE_CONCLUSIONS.includes(job.conclusion)) entry.failed++;
          jobFailMap.set(job.name, entry);
        }
      }
    }

    let penalty = 0;
    const failRate = totalRuns > 0 ? failedRuns / totalRuns : 0;
    if (failRate > 0.2) penalty += 10;

    const flakyCount = [...jobFailMap.values()].filter(
      (j) => j.total >= 5 && j.failed / j.total > 0.2
    ).length;
    penalty += Math.min(flakyCount * 5, 20);

    const avgP95 = allP95s.length > 0 ? allP95s.reduce((a, b) => a + b, 0) / allP95s.length : 0;
    if (avgP95 > 15 * 60 * 1000) penalty += 5;

    return penalty;
  } catch {
    return 0; // CI data not available — no penalty
  }
}
