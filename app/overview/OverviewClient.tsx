'use client';

import { AppShell } from '@/components/AppShell';
import { TeamHealthCard } from '@/components/overview/TeamHealthCard';
import { RepoComparisonTable } from '@/components/overview/RepoComparisonTable';

interface RepoHealthSummary {
  repoId: string;
  fullName: string;
  language: string | null;
  lastScannedAt: string | null;
  riskScore: number;
  cveCount: number;
  criticalCount: number;
  highCount: number;
  licenseIssues: number;
  outdatedDeps: number;
  totalDeps: number;
  healthScore: number;
}

interface Aggregate {
  totalRepos: number;
  scannedRepos: number;
  avgRiskScore: number;
  totalCVEs: number;
  totalCritical: number;
  totalHigh: number;
  totalLicenseIssues: number;
  highRiskRepos: number;
  mediumRiskRepos: number;
  lowRiskRepos: number;
  overallHealthScore: number;
}

interface OverviewData {
  repos: RepoHealthSummary[];
  aggregate: Aggregate;
  topRiskyRepos: RepoHealthSummary[];
  mostOutdated: RepoHealthSummary[];
}

interface OverviewClientProps {
  data: OverviewData;
}

export function OverviewClient({ data }: OverviewClientProps) {
  const { aggregate, topRiskyRepos, mostOutdated, repos } = data;

  return (
    <AppShell repoCount={aggregate.totalRepos}>
      <div className="space-y-6">
        <TeamHealthCard aggregate={aggregate} />

        {topRiskyRepos.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top risky repos */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Risikoreichste Repos</h3>
              <div className="space-y-2">
                {topRiskyRepos.map((repo, i) => (
                  <div key={repo.repoId} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 w-4 tabular-nums">{i + 1}.</span>
                      <span className="text-sm text-gray-300 truncate max-w-[180px]">{repo.fullName}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {repo.criticalCount > 0 && (
                        <span className="text-xs text-red-400 font-medium tabular-nums">{repo.criticalCount} krit.</span>
                      )}
                      <span className={`text-sm font-bold tabular-nums ${
                        repo.riskScore >= 70 ? 'text-red-400' : repo.riskScore >= 40 ? 'text-orange-400' : 'text-yellow-400'
                      }`}>
                        {repo.riskScore}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Most outdated deps */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Meiste veraltete Deps</h3>
              <div className="space-y-2">
                {mostOutdated.map((repo, i) => {
                  const pct = repo.totalDeps > 0 ? Math.round((repo.outdatedDeps / repo.totalDeps) * 100) : 0;
                  return (
                    <div key={repo.repoId} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 w-4 tabular-nums">{i + 1}.</span>
                        <span className="text-sm text-gray-300 truncate max-w-[180px]">{repo.fullName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-20 bg-gray-800 rounded-full h-1">
                          <div
                            className={`h-1 rounded-full ${pct > 50 ? 'bg-red-400' : pct > 25 ? 'bg-orange-400' : 'bg-yellow-400'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-8 text-right tabular-nums">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
                {mostOutdated.length === 0 && (
                  <p className="text-sm text-gray-600">Keine Dependency-Scans vorhanden.</p>
                )}
              </div>
            </div>
          </div>
        )}

        <RepoComparisonTable repos={repos} />
      </div>
    </AppShell>
  );
}
