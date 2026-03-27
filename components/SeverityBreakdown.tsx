'use client';

interface Counts {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface SeverityBreakdownProps {
  counts: Counts;
  riskScore: number;
}

export function SeverityBreakdown({ counts, riskScore }: SeverityBreakdownProps) {
  const riskColor =
    riskScore >= 70
      ? 'text-red-600'
      : riskScore >= 40
        ? 'text-orange-500'
        : riskScore >= 10
          ? 'text-yellow-500'
          : 'text-green-600';

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">CVE Zusammenfassung</h3>
        <span className={`text-2xl font-bold ${riskColor}`}>{riskScore}</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">Risiko-Score (0–100)</p>

      <div className="grid grid-cols-4 gap-2">
        <SeverityCount label="Kritisch" count={counts.critical} color="red" />
        <SeverityCount label="Hoch" count={counts.high} color="orange" />
        <SeverityCount label="Mittel" count={counts.medium} color="yellow" />
        <SeverityCount label="Niedrig" count={counts.low} color="blue" />
      </div>

      <p className="text-xs text-gray-400 mt-2 text-right">{counts.total} CVEs gesamt</p>
    </div>
  );
}

interface SeverityCountProps {
  label: string;
  count: number;
  color: 'red' | 'orange' | 'yellow' | 'blue';
}

const COLOR_MAP = {
  red: 'bg-red-50 border-red-200 text-red-700',
  orange: 'bg-orange-50 border-orange-200 text-orange-700',
  yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  blue: 'bg-blue-50 border-blue-200 text-blue-700',
};

function SeverityCount({ label, count, color }: SeverityCountProps) {
  return (
    <div className={`rounded border p-2 text-center ${COLOR_MAP[color]}`}>
      <div className="text-xl font-bold">{count}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
