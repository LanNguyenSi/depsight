'use client';

import { useState, useMemo } from 'react';
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

type SortColumn = 'name' | 'health' | 'risk' | 'cves' | 'critical' | 'licenses' | 'outdated' | 'scanned';
type SortDir = 'asc' | 'desc';

const SORT_FNS: Record<SortColumn, (a: RepoHealthSummary, b: RepoHealthSummary) => number> = {
  name: (a, b) => a.fullName.localeCompare(b.fullName),
  health: (a, b) => a.healthScore - b.healthScore,
  risk: (a, b) => a.riskScore - b.riskScore,
  cves: (a, b) => a.cveCount - b.cveCount,
  critical: (a, b) => a.criticalCount - b.criticalCount,
  licenses: (a, b) => a.licenseIssues - b.licenseIssues,
  outdated: (a, b) => {
    const aPct = a.totalDeps > 0 ? a.outdatedDeps / a.totalDeps : 0;
    const bPct = b.totalDeps > 0 ? b.outdatedDeps / b.totalDeps : 0;
    return aPct - bPct;
  },
  scanned: (a, b) => {
    const aTime = a.lastScannedAt ? new Date(a.lastScannedAt).getTime() : 0;
    const bTime = b.lastScannedAt ? new Date(b.lastScannedAt).getTime() : 0;
    return aTime - bTime;
  },
};

export function RepoComparisonTable({ repos, onSelectRepo }: RepoComparisonTableProps) {
  const { t } = useLocale();
  const [sortCol, setSortCol] = useState<SortColumn>('health');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    const fn = SORT_FNS[sortCol];
    const list = [...repos].sort(fn);
    if (sortDir === 'desc') list.reverse();
    return list;
  }, [repos, sortCol, sortDir]);

  const paginatedRepos = usePagination(sorted, page, PAGE_SIZE);

  function handleSort(col: SortColumn) {
    if (col === sortCol) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      // Default: descending for numeric columns, ascending for name
      setSortDir(col === 'name' ? 'asc' : 'desc');
    }
    setPage(1);
  }

  const healthColor = (score: number) =>
    score >= 70 ? 'text-emerald-400' : score >= 40 ? 'text-yellow-400' : 'text-red-400';

  const riskColor = (score: number) =>
    score >= 70 ? 'text-red-400' : score >= 40 ? 'text-orange-400' : score >= 10 ? 'text-yellow-400' : 'text-emerald-400';

  const outdatedPercent = (r: RepoHealthSummary) =>
    r.totalDeps > 0 ? Math.round((r.outdatedDeps / r.totalDeps) * 100) : 0;

  const columns: Array<{ key: SortColumn; label: string; align: 'left' | 'center' }> = [
    { key: 'name', label: t['overview.col.repository'], align: 'left' },
    { key: 'health', label: t['overview.col.health'], align: 'center' },
    { key: 'risk', label: t['overview.col.risk'], align: 'center' },
    { key: 'cves', label: t['overview.col.cves'], align: 'center' },
    { key: 'critical', label: t['overview.col.critical'], align: 'center' },
    { key: 'licenses', label: t['overview.col.licenses'], align: 'center' },
    { key: 'outdated', label: t['overview.col.outdated'], align: 'center' },
    { key: 'scanned', label: t['overview.col.scanned'], align: 'left' },
  ];

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <h3 className="text-sm font-medium text-gray-400">{t['overview.repoComparison']}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-800">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`${col.align === 'left' ? 'text-left' : 'text-center'} ${col.key === 'name' ? 'px-4' : 'px-3'} py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-300 transition-colors select-none`}
                >
                  {col.label}
                  {sortCol === col.key && (
                    <span className="ml-1 text-blue-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
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
                    <span className="text-sm font-semibold text-red-400 tabular-nums">{repo.licenseIssues}</span>
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
