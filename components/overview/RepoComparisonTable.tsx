'use client';

import { useState } from 'react';
import { useLocale } from '@/lib/i18n';
import { Pagination, usePagination } from '@/components/Pagination';

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
  const { t } = useLocale();
  const healthColor = (score: number) =>
    score >= 70 ? 'text-emerald-400' : score >= 40 ? 'text-yellow-400' : 'text-red-400';

  const riskColor = (score: number) =>
    score >= 70 ? 'text-red-400' : score >= 40 ? 'text-orange-400' : score >= 10 ? 'text-yellow-400' : 'text-emerald-400';

  const outdatedPercent = (r: RepoHealthSummary) =>
    r.totalDeps > 0 ? Math.round((r.outdatedDeps / r.totalDeps) * 100) : 0;

  const sorted = [...repos].sort((a, b) => a.healthScore - b.healthScore);
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  const paginatedRepos = usePagination(sorted, page, PAGE_SIZE);

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <h3 className="text-sm font-medium text-gray-300">{t['overview.repoComparison']}</h3>
        <p className="text-[10px] text-gray-600 mt-0.5">{t['overview.sortedByHealth']}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-800">
            <tr>
              <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.repository']}</th>
              <th className="text-center px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.health']}</th>
              <th className="text-center px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.risk']}</th>
              <th className="text-center px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.cves']}</th>
              <th className="text-center px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.critical']}</th>
              <th className="text-center px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.licenses']}</th>
              <th className="text-center px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.outdated']}</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['overview.col.scanned']}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {paginatedRepos.map((repo) => (
              <tr
                key={repo.repoId}
                onClick={() => onSelectRepo?.(repo.repoId)}
                className={`hover:bg-gray-800/30 transition-colors ${onSelectRepo ? 'cursor-pointer' : ''}`}
              >
                <td className="px-4 py-2.5">
                  <div className="font-medium text-gray-300 truncate max-w-[200px]">{repo.fullName}</div>
                  {repo.language && <div className="text-[10px] text-gray-600">{repo.language}</div>}
                </td>
                <td className="px-3 py-2.5 text-center">
                  <span className={`font-bold text-sm tabular-nums ${healthColor(repo.healthScore)}`}>
                    {repo.healthScore}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <span className={`font-bold text-sm tabular-nums ${riskColor(repo.riskScore)}`}>
                    {repo.riskScore}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center text-sm text-gray-400 tabular-nums">{repo.cveCount}</td>
                <td className="px-3 py-2.5 text-center">
                  {repo.criticalCount > 0 ? (
                    <span className="text-sm font-semibold text-red-400 tabular-nums">{repo.criticalCount}</span>
                  ) : (
                    <span className="text-sm text-gray-700">&ndash;</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-center">
                  {repo.licenseIssues > 0 ? (
                    <span className="text-sm font-semibold text-orange-400 tabular-nums">{repo.licenseIssues}</span>
                  ) : (
                    <span className="text-sm text-gray-700">&ndash;</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-center">
                  {repo.totalDeps > 0 ? (
                    <span className={`text-sm tabular-nums ${outdatedPercent(repo) > 30 ? 'text-orange-400 font-semibold' : 'text-gray-500'}`}>
                      {outdatedPercent(repo)}%
                    </span>
                  ) : (
                    <span className="text-sm text-gray-700">&ndash;</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-600 tabular-nums">
                  {repo.lastScannedAt
                    ? new Date(repo.lastScannedAt).toLocaleDateString('de-DE')
                    : '\u2013'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {repos.length === 0 && (
          <div className="text-center py-8 text-gray-600 text-sm">
            {t['overview.noRepos']}
          </div>
        )}
      </div>
      {repos.length > PAGE_SIZE && (
        <div className="px-4 py-3 border-t border-gray-800">
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={sorted.length}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
