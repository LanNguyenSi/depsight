export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getTeamHealthOverview } from '@/lib/overview/team-health';
import { TeamHealthCard } from '@/components/overview/TeamHealthCard';
import { RepoComparisonTable } from '@/components/overview/RepoComparisonTable';
import Link from 'next/link';

export default async function OverviewPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const overview = await getTeamHealthOverview(session.user.id);

  const serialized = {
    repos: overview.repos.map((r) => ({
      ...r,
      lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    })),
    aggregate: overview.aggregate,
    topRiskyRepos: overview.topRiskyRepos.map((r) => ({
      ...r,
      lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    })),
    mostOutdated: overview.mostOutdated.map((r) => ({
      ...r,
      lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    })),
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-gray-900">🔍 depsight</h1>
            <nav className="flex items-center gap-1 text-sm">
              <Link href="/dashboard" className="px-3 py-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors">
                Dashboard
              </Link>
              <Link href="/overview" className="px-3 py-1.5 text-blue-600 bg-blue-50 rounded-lg font-medium">
                Übersicht
              </Link>
            </nav>
          </div>
          <span className="text-sm text-gray-500">{overview.aggregate.totalRepos} Repositories</span>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Team Health Card */}
        <TeamHealthCard aggregate={serialized.aggregate} />

        {/* Top 5 Risky Repos */}
        {serialized.topRiskyRepos.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">🔴 Risikoreichste Repos</h3>
              <div className="space-y-2">
                {serialized.topRiskyRepos.map((repo, i) => (
                  <div key={repo.repoId} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 w-4">{i + 1}.</span>
                      <span className="text-sm text-gray-700 truncate max-w-[180px]">{repo.fullName}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {repo.criticalCount > 0 && (
                        <span className="text-xs text-red-600 font-medium">🔴 {repo.criticalCount}</span>
                      )}
                      <span className={`text-sm font-bold ${repo.riskScore >= 70 ? 'text-red-600' : repo.riskScore >= 40 ? 'text-orange-500' : 'text-yellow-500'}`}>
                        {repo.riskScore}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">📦 Meiste veraltete Deps</h3>
              <div className="space-y-2">
                {serialized.mostOutdated.map((repo, i) => {
                  const pct = repo.totalDeps > 0 ? Math.round((repo.outdatedDeps / repo.totalDeps) * 100) : 0;
                  return (
                    <div key={repo.repoId} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-4">{i + 1}.</span>
                        <span className="text-sm text-gray-700 truncate max-w-[180px]">{repo.fullName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-20 bg-gray-200 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${pct > 50 ? 'bg-red-500' : pct > 25 ? 'bg-orange-400' : 'bg-yellow-400'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-600 w-8 text-right">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
                {serialized.mostOutdated.length === 0 && (
                  <p className="text-sm text-gray-400">Keine Dependency-Scans vorhanden.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Full comparison table */}
        <RepoComparisonTable repos={serialized.repos} />
      </div>
    </div>
  );
}
