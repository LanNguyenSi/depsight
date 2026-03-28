'use client';

interface LicenseEntry {
  id: string;
  packageName: string;
  version: string;
  license: string;
  isCompatible: boolean;
  policyViolation: boolean;
  needsReview?: boolean;
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

  const violations = licenses.filter((l) => l.policyViolation);
  const needsReview = licenses.filter((l) => !l.policyViolation && l.needsReview);
  const compatible = licenses.filter((l) => !l.policyViolation && !l.needsReview && l.isCompatible);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400">Lizenz-Übersicht</h3>
          {conflictCount > 0 ? (
            <span className="text-xs font-medium text-red-400 bg-red-950/50 px-2 py-0.5 rounded border border-red-900/50">
              {conflictCount} Konflikte
            </span>
          ) : (
            <span className="text-xs font-medium text-emerald-400 bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-900/50">
              Keine Konflikte
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {topLicenses.map(([license, count]) => (
            <span
              key={license}
              className="inline-flex items-center gap-1 px-2 py-1 bg-gray-800 text-gray-400 text-xs rounded"
            >
              <span className="font-mono">{license}</span>
              <span className="text-gray-600">&times;{count}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Policy violations */}
      {violations.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-red-400 mb-2 uppercase tracking-wider">Copyleft-Konflikte</h4>
          <div className="space-y-1">
            {violations.map((l) => (
              <LicenseRow key={l.id} entry={l} />
            ))}
          </div>
        </div>
      )}

      {/* Needs review */}
      {needsReview.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-yellow-400 mb-2 uppercase tracking-wider">Review empfohlen</h4>
          <div className="space-y-1">
            {needsReview.map((l) => (
              <LicenseRow key={l.id} entry={l} />
            ))}
          </div>
        </div>
      )}

      {/* Compatible */}
      {compatible.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">
            Kompatibel ({compatible.length})
          </h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {compatible.map((l) => (
              <LicenseRow key={l.id} entry={l} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LicenseRow({ entry }: { entry: LicenseEntry }) {
  const dotColor = entry.policyViolation
    ? 'bg-red-400'
    : entry.needsReview
      ? 'bg-yellow-400'
      : 'bg-emerald-400';

  const licenseColor = entry.policyViolation
    ? 'text-red-400 bg-red-950/40 border-red-900/40'
    : entry.needsReview
      ? 'text-yellow-400 bg-yellow-950/40 border-yellow-900/40'
      : 'text-emerald-400 bg-emerald-950/40 border-emerald-900/40';

  return (
    <div className="flex items-center justify-between px-3 py-2 bg-gray-900 rounded-md border border-gray-800 hover:border-gray-700 text-sm transition-colors">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="font-mono text-gray-300">{entry.packageName}</span>
        <span className="text-gray-600 text-xs">{entry.version}</span>
      </div>
      <span className={`font-mono text-xs px-1.5 py-0.5 rounded border ${licenseColor}`}>
        {entry.license}
      </span>
    </div>
  );
}
