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

function calcHealthScore(repo: Pick<RepoHealthSummary, 'riskScore' | 'licenseIssues' | 'outdatedDeps' | 'totalDeps'>): number {
  // Health = inverse risk + license health + dep freshness
  const riskPenalty = repo.riskScore; // 0-100, lower risk = higher health
  const licensePenalty = Math.min(repo.licenseIssues * 5, 20); // max 20 points penalty
  const depPenalty = repo.totalDeps > 0
    ? Math.min((repo.outdatedDeps / repo.totalDeps) * 30, 30) // max 30 points penalty
    : 0;

  const raw = 100 - riskPenalty * 0.5 - licensePenalty - depPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export async function getTeamHealthOverview(userId: string): Promise<TeamHealthOverview> {
  const repos = await prisma.repo.findMany({
    where: { userId, tracked: true },
    orderBy: { updatedAt: 'desc' },
    include: {
      scans: {
        where: { status: 'COMPLETED' },
        orderBy: { scannedAt: 'desc' },
        take: 1,
        select: {
          riskScore: true,
          cveCount: true,
          criticalCount: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
          licenseIssues: true,
          _count: { select: { dependencies: true } },
        },
      },
    },
  });

  // Get outdated dep counts per repo (separate query for performance)
  const outdatedCounts = await prisma.dependency.groupBy({
    by: ['scanId'],
    where: {
      status: { in: ['OUTDATED', 'MAJOR_BEHIND', 'DEPRECATED'] },
      scan: { repo: { userId }, status: 'COMPLETED' },
    },
    _count: true,
  });

  // Build scanId → outdated count lookup
  const outdatedByScanId = new Map(outdatedCounts.map((r) => [r.scanId, r._count]));

  // Get the latest scan ID per repo to join outdated counts
  const latestScanIds = new Map<string, string>();
  for (const repo of repos) {
    if (repo.scans[0]) {
      // We need to get the actual scan ID — re-query
    }
  }

  // Simpler: fetch latest scan IDs for outdated deps
  const latestScans = await prisma.scan.findMany({
    where: { repo: { userId }, status: 'COMPLETED' },
    orderBy: { scannedAt: 'desc' },
    distinct: ['repoId'],
    select: { id: true, repoId: true },
  });
  for (const s of latestScans) {
    latestScanIds.set(s.repoId, s.id);
  }

  const summaries: RepoHealthSummary[] = repos.map((repo) => {
    const scan = repo.scans[0];
    const scanId = latestScanIds.get(repo.id);
    const outdated = scanId ? (outdatedByScanId.get(scanId) ?? 0) : 0;
    const totalDeps = scan?._count.dependencies ?? 0;

    const summary: RepoHealthSummary = {
      repoId: repo.id,
      fullName: repo.fullName,
      owner: repo.owner,
      name: repo.name,
      language: repo.language,
      lastScannedAt: repo.lastScannedAt,
      riskScore: scan?.riskScore ?? 0,
      cveCount: scan?.cveCount ?? 0,
      criticalCount: scan?.criticalCount ?? 0,
      highCount: scan?.highCount ?? 0,
      mediumCount: scan?.mediumCount ?? 0,
      lowCount: scan?.lowCount ?? 0,
      licenseIssues: scan?.licenseIssues ?? 0,
      outdatedDeps: outdated,
      totalDeps,
      healthScore: 0,
    };
    summary.healthScore = calcHealthScore(summary);
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
