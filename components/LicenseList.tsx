'use client';

interface LicenseEntry {
  id: string;
  packageName: string;
  version: string;
  license: string;
  isCompatible: boolean;
  policyViolation: boolean;
}

interface LicenseListProps {
  licenses: LicenseEntry[];
  summary: Record<string, number>;
  conflictCount: number;
}

export function LicenseList({ licenses, summary, conflictCount }: LicenseListProps) {
  const topLicenses = Object.entries(summary)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Lizenz-Übersicht</h3>
          {conflictCount > 0 ? (
            <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded border border-red-200">
              ⚠️ {conflictCount} Konflikte
            </span>
          ) : (
            <span className="text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded border border-green-200">
              ✅ Keine Konflikte
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {topLicenses.map(([license, count]) => (
            <span
              key={license}
              className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded"
            >
              <span className="font-mono">{license}</span>
              <span className="text-gray-400">×{count}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Issues first */}
      {licenses.filter((l) => l.policyViolation || !l.isCompatible).length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-red-700 mb-2">⚠️ Problematische Lizenzen</h4>
          <div className="space-y-1">
            {licenses
              .filter((l) => l.policyViolation || !l.isCompatible)
              .map((l) => (
                <LicenseRow key={l.id} entry={l} />
              ))}
          </div>
        </div>
      )}

      {/* All licenses */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">
          Alle Lizenzen ({licenses.length})
        </h4>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {licenses
            .filter((l) => !l.policyViolation && l.isCompatible)
            .map((l) => (
              <LicenseRow key={l.id} entry={l} />
            ))}
        </div>
      </div>
    </div>
  );
}

function LicenseRow({ entry }: { entry: { packageName: string; version: string; license: string; isCompatible: boolean; policyViolation: boolean } }) {
  const statusIcon = entry.policyViolation
    ? '🔴'
    : entry.isCompatible
      ? '🟢'
      : '🟡';

  const licenseColor = entry.policyViolation
    ? 'text-red-700 bg-red-50 border-red-200'
    : entry.isCompatible
      ? 'text-green-700 bg-green-50 border-green-200'
      : 'text-yellow-700 bg-yellow-50 border-yellow-200';

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-white rounded border border-gray-100 hover:border-gray-200 text-sm">
      <div className="flex items-center gap-2">
        <span>{statusIcon}</span>
        <span className="font-mono text-gray-700">{entry.packageName}</span>
        <span className="text-gray-400 text-xs">{entry.version}</span>
      </div>
      <span className={`font-mono text-xs px-1.5 py-0.5 rounded border ${licenseColor}`}>
        {entry.license}
      </span>
    </div>
  );
}
