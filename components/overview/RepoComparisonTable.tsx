'use client';

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

interface RepoComparisonTableProps {
  repos: RepoHealthSummary[];
  onSelectRepo?: (repoId: string) => void;
}

export function RepoComparisonTable({ repos, onSelectRepo }: RepoComparisonTableProps) {
  const healthColor = (score: number) =>
    score >= 70 ? 'text-green-600' : score >= 40 ? 'text-yellow-600' : 'text-red-600';

  const riskColor = (score: number) =>
    score >= 70 ? 'text-red-600' : score >= 40 ? 'text-orange-500' : score >= 10 ? 'text-yellow-500' : 'text-green-600';

  const outdatedPercent = (r: RepoHealthSummary) =>
    r.totalDeps > 0 ? Math.round((r.outdatedDeps / r.totalDeps) * 100) : 0;

  // Sort by health score ascending (worst first)
  const sorted = [...repos].sort((a, b) => a.healthScore - b.healthScore);

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-700">📊 Repository Vergleich</h3>
        <p className="text-xs text-gray-400 mt-0.5">Sortiert nach Health Score (schlechteste zuerst)</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600">Repository</th>
              <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600">Health</th>
              <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600">Risk</th>
              <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600">CVEs</th>
              <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600">🔴 Krit.</th>
              <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600">Lizenzen</th>
              <th className="text-center px-3 py-2 text-xs font-semibold text-gray-600">Veraltet</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600">Gescannt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((repo) => (
              <tr
                key={repo.repoId}
                onClick={() => onSelectRepo?.(repo.repoId)}
                className={`hover:bg-gray-50 transition-colors ${onSelectRepo ? 'cursor-pointer' : ''}`}
              >
                <td className="px-4 py-2">
                  <div className="font-medium text-gray-800 truncate max-w-[200px]">{repo.fullName}</div>
                  {repo.language && <div className="text-xs text-gray-400">{repo.language}</div>}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`font-bold text-sm ${healthColor(repo.healthScore)}`}>
                    {repo.healthScore}
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`font-bold text-sm ${riskColor(repo.riskScore)}`}>
                    {repo.riskScore}
                  </span>
                </td>
                <td className="px-3 py-2 text-center text-sm text-gray-700">{repo.cveCount}</td>
                <td className="px-3 py-2 text-center">
                  {repo.criticalCount > 0 ? (
                    <span className="text-sm font-semibold text-red-600">{repo.criticalCount}</span>
                  ) : (
                    <span className="text-sm text-gray-400">–</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {repo.licenseIssues > 0 ? (
                    <span className="text-sm font-semibold text-orange-600">{repo.licenseIssues}</span>
                  ) : (
                    <span className="text-sm text-gray-400">–</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {repo.totalDeps > 0 ? (
                    <span className={`text-sm ${outdatedPercent(repo) > 30 ? 'text-orange-600 font-semibold' : 'text-gray-600'}`}>
                      {outdatedPercent(repo)}%
                    </span>
                  ) : (
                    <span className="text-sm text-gray-400">–</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-gray-400">
                  {repo.lastScannedAt
                    ? new Date(repo.lastScannedAt).toLocaleDateString('de-DE')
                    : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {repos.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm">
            Keine Repos gefunden – bitte erst synchronisieren.
          </div>
        )}
      </div>
    </div>
  );
}
