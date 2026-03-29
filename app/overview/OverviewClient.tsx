'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, interpolate } from '@/lib/i18n';
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
  const router = useRouter();
  const { t } = useLocale();

  function navigateToRepo(repoId: string) {
    router.push(`/dashboard?repo=${repoId}`);
  }

  return (
    <AppShell repoCount={aggregate.totalRepos}>
      <div className="space-y-6">
        <TeamHealthCard aggregate={aggregate} />

        {aggregate.scannedRepos < aggregate.totalRepos && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 flex items-center justify-between">
            <p className="text-sm text-blue-300">
              {interpolate(t['overview.unscannedNotice'], {
                count: aggregate.totalRepos - aggregate.scannedRepos,
                total: aggregate.totalRepos,
              })}
            </p>
            <Link
              href="/dashboard"
              className="shrink-0 text-xs font-medium px-3 py-1.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30 transition-colors"
            >
              {t['overview.unscannedAction']}
            </Link>
          </div>
        )}

        {topRiskyRepos.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top risky repos */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">{t['overview.riskyRepos']}</h3>
              <div className="space-y-2">
                {topRiskyRepos.map((repo, i) => (
                  <button
                    key={repo.repoId}
                    onClick={() => navigateToRepo(repo.repoId)}
                    className="w-full flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-gray-800/50 transition-colors text-left"
                  >
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
                  </button>
                ))}
              </div>
            </div>

            {/* Most outdated deps */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">{t['overview.outdatedDeps']}</h3>
              <div className="space-y-2">
                {mostOutdated.map((repo, i) => {
                  const pct = repo.totalDeps > 0 ? Math.round((repo.outdatedDeps / repo.totalDeps) * 100) : 0;
                  return (
                    <button
                      key={repo.repoId}
                      onClick={() => navigateToRepo(repo.repoId)}
                      className="w-full flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-gray-800/50 transition-colors text-left"
                    >
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
                    </button>
                  );
                })}
                {mostOutdated.length === 0 && (
                  <p className="text-sm text-gray-600">{t['overview.noDepsScans']}</p>
                )}
              </div>
            </div>
          </div>
        )}

        <RepoComparisonTable repos={repos} onSelectRepo={navigateToRepo} />
      </div>
    </AppShell>
  );
}
