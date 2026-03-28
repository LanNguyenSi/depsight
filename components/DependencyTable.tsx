'use client';

import { useLocale, interpolate } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n';

type DepStatus = 'UP_TO_DATE' | 'OUTDATED' | 'MAJOR_BEHIND' | 'DEPRECATED' | 'UNKNOWN';

interface DepSummary {
  total: number;
  upToDate: number;
  outdated: number;
  majorBehind: number;
  deprecated: number;
  unknown: number;
}

interface DepEntry {
  id: string;
  name: string;
  installedVersion: string;
  latestVersion: string;
  ageInDays: number | null;
  status: DepStatus;
  isDeprecated: boolean;
  updateAvailable: boolean;
}

interface DependencyTableProps {
  dependencies: DepEntry[];
  summary: DepSummary;
}

const STATUS_STYLES: Record<DepStatus, { cls: string }> = {
  UP_TO_DATE:   { cls: 'text-emerald-400 bg-emerald-950/50 border-emerald-900/50' },
  OUTDATED:     { cls: 'text-yellow-400 bg-yellow-950/50 border-yellow-900/50' },
  MAJOR_BEHIND: { cls: 'text-orange-400 bg-orange-950/50 border-orange-900/50' },
  DEPRECATED:   { cls: 'text-red-400 bg-red-950/50 border-red-900/50' },
  UNKNOWN:      { cls: 'text-gray-500 bg-gray-800 border-gray-700' },
};

function statusLabel(status: DepStatus, t: Translations): string {
  switch (status) {
    case 'UP_TO_DATE': return t['deps.upToDate'];
    case 'OUTDATED': return t['deps.outdated'];
    case 'MAJOR_BEHIND': return t['deps.majorBehind'];
    case 'DEPRECATED': return t['deps.deprecated'];
    case 'UNKNOWN': return t['deps.unknown'];
  }
}

function formatAge(days: number | null): string {
  if (days === null || days < 0) return '\u2013';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}j`;
}

export function DependencyTable({ dependencies, summary }: DependencyTableProps) {
  const { t } = useLocale();

  const outdatedTotal = summary.outdated + summary.majorBehind + summary.deprecated;
  const healthPercent = summary.total > 0 ? Math.round((summary.upToDate / summary.total) * 100) : 100;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400">{t['deps.title']}</h3>
          <span className={`text-lg font-bold tabular-nums ${healthPercent >= 80 ? 'text-emerald-400' : healthPercent >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
            {healthPercent}%
            <span className="text-xs font-normal text-gray-600 ml-1">{t['deps.current']}</span>
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
          {([
            [t['deps.upToDate'], summary.upToDate, 'text-emerald-400'],
            [t['deps.outdated'], summary.outdated, 'text-yellow-400'],
            [t['deps.majorBehind'], summary.majorBehind, 'text-orange-400'],
            [t['deps.deprecated'], summary.deprecated, 'text-red-400'],
            [t['deps.unknown'], summary.unknown, 'text-gray-600'],
          ] as const).map(([label, count, color]) => (
            <div key={label} className="bg-gray-800/50 rounded-lg p-3">
              <div className={`text-lg font-bold tabular-nums ${color}`}>{count}</div>
              <div className="text-xs text-gray-600">{label}</div>
            </div>
          ))}
        </div>
        {outdatedTotal > 0 && (
          <p className="text-xs text-orange-400 mt-2">
            {interpolate(t['deps.needUpdates'], { count: outdatedTotal })}
          </p>
        )}
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-800">
            <tr>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['deps.col.package']}</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['deps.col.installed']}</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['deps.col.latest']}</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['deps.col.age']}</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t['deps.col.status']}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {dependencies.map((dep) => {
              const style = STATUS_STYLES[dep.status];
              return (
                <tr key={dep.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-3 py-2 font-mono text-gray-300 max-w-[200px] truncate text-xs">
                    {dep.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-600 text-xs">
                    {dep.installedVersion || '\u2013'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {dep.updateAvailable ? (
                      <span className="text-blue-400 font-medium">{dep.latestVersion}</span>
                    ) : (
                      <span className="text-gray-600">{dep.latestVersion || '\u2013'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 tabular-nums">
                    {formatAge(dep.ageInDays)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${style.cls}`}>
                      {statusLabel(dep.status, t)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {dependencies.length === 0 && (
          <div className="text-center py-8 text-gray-600 text-sm">
            {t['deps.empty']}
          </div>
        )}
      </div>
    </div>
  );
}
