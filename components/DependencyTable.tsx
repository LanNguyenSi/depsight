'use client';

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

const STATUS_STYLES: Record<DepStatus, { label: string; badge: string; icon: string }> = {
  UP_TO_DATE: { label: 'Aktuell', badge: 'bg-green-100 text-green-700 border-green-200', icon: '✅' },
  OUTDATED:   { label: 'Veraltet', badge: 'bg-yellow-100 text-yellow-700 border-yellow-200', icon: '⚠️' },
  MAJOR_BEHIND: { label: 'Major hinter', badge: 'bg-orange-100 text-orange-700 border-orange-200', icon: '🔶' },
  DEPRECATED: { label: 'Deprecated', badge: 'bg-red-100 text-red-700 border-red-200', icon: '🔴' },
  UNKNOWN:    { label: 'Unbekannt', badge: 'bg-gray-100 text-gray-600 border-gray-200', icon: '❓' },
};

function formatAge(days: number | null): string {
  if (days === null || days < 0) return '–';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}j`;
}

export function DependencyTable({ dependencies, summary }: DependencyTableProps) {
  const outdatedTotal = summary.outdated + summary.majorBehind + summary.deprecated;
  const healthPercent = summary.total > 0 ? Math.round((summary.upToDate / summary.total) * 100) : 100;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Dependency Health</h3>
          <span className={`text-lg font-bold ${healthPercent >= 80 ? 'text-green-600' : healthPercent >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
            {healthPercent}% aktuell
          </span>
        </div>
        <div className="grid grid-cols-5 gap-2 text-center">
          {([
            ['Aktuell', summary.upToDate, 'text-green-600'],
            ['Veraltet', summary.outdated, 'text-yellow-600'],
            ['Major ↑', summary.majorBehind, 'text-orange-600'],
            ['Deprecated', summary.deprecated, 'text-red-600'],
            ['Unbekannt', summary.unknown, 'text-gray-400'],
          ] as const).map(([label, count, color]) => (
            <div key={label} className="bg-gray-50 rounded p-2">
              <div className={`text-lg font-bold ${color}`}>{count}</div>
              <div className="text-xs text-gray-500">{label}</div>
            </div>
          ))}
        </div>
        {outdatedTotal > 0 && (
          <p className="text-xs text-orange-600 mt-2">
            ⚠️ {outdatedTotal} Pakete benötigen Updates
          </p>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600">Paket</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600">Installiert</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600">Aktuell</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600">Alter</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {dependencies.map((dep) => {
              const style = STATUS_STYLES[dep.status];
              return (
                <tr key={dep.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-3 py-2 font-mono text-gray-800 max-w-[200px] truncate">
                    {dep.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-500 text-xs">
                    {dep.installedVersion || '–'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {dep.updateAvailable ? (
                      <span className="text-blue-600 font-semibold">{dep.latestVersion}</span>
                    ) : (
                      <span className="text-gray-400">{dep.latestVersion || '–'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {formatAge(dep.ageInDays)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs ${style.badge}`}>
                      {style.icon} {style.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {dependencies.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm">
            Keine Abhängigkeiten gefunden.
          </div>
        )}
      </div>
    </div>
  );
}
