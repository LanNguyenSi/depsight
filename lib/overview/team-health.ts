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
  });

  // Get latest CVE scan per repo (for risk scores)
  const cveScansByRepo = new Map<string, {
    riskScore: number; cveCount: number; criticalCount: number;
    highCount: number; mediumCount: number; lowCount: number;
  }>();
  const cveScans = await prisma.scan.findMany({
    where: { repo: { userId }, status: 'COMPLETED', cvePayload: { not: Prisma.DbNull } },
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
    where: { repo: { userId }, status: 'COMPLETED', licenseCount: { gt: 0 } },
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
    where: { repo: { userId }, status: 'COMPLETED', dependencies: { some: {} } },
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

  const summaries: RepoHealthSummary[] = repos.map((repo) => {
    const cveScan = cveScansByRepo.get(repo.id);
    const licenseScan = licenseScansByRepo.get(repo.id);
    const depsScan = depsScansByRepo.get(repo.id);
    const outdated = depsScan ? (outdatedByScanId.get(depsScan.scanId) ?? 0) : 0;
    const totalDeps = depsScan?.depCount ?? 0;

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
