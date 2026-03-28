'use client';

import { useLocale, interpolate } from '@/lib/i18n';

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
  const { t } = useLocale();

  const riskColor =
    riskScore >= 70
      ? 'text-red-400'
      : riskScore >= 40
        ? 'text-orange-400'
        : riskScore >= 10
          ? 'text-yellow-400'
          : 'text-emerald-400';

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-400">{t['severity.title']}</h3>
        <div className="text-right">
          <span className={`text-2xl font-bold tabular-nums ${riskColor}`}>{riskScore}</span>
          <p className="text-[10px] text-gray-600">{t['severity.riskScore']}</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <SeverityCount label={t['severity.critical']} count={counts.critical} color="red" />
        <SeverityCount label={t['severity.high']} count={counts.high} color="orange" />
        <SeverityCount label={t['severity.medium']} count={counts.medium} color="yellow" />
        <SeverityCount label={t['severity.low']} count={counts.low} color="blue" />
      </div>

      <p className="text-[10px] text-gray-600 mt-2 text-right tabular-nums">{interpolate(t['severity.total'], { count: counts.total })}</p>
    </div>
  );
}

interface SeverityCountProps {
  label: string;
  count: number;
  color: 'red' | 'orange' | 'yellow' | 'blue';
}

const COLOR_MAP = {
  red: 'bg-red-950/50 border-red-900/50 text-red-400',
  orange: 'bg-orange-950/50 border-orange-900/50 text-orange-400',
  yellow: 'bg-yellow-950/50 border-yellow-900/50 text-yellow-400',
  blue: 'bg-blue-950/50 border-blue-900/50 text-blue-400',
};

function SeverityCount({ label, count, color }: SeverityCountProps) {
  return (
    <div className={`rounded-md border p-2 text-center ${COLOR_MAP[color]}`}>
      <div className="text-xl font-bold tabular-nums">{count}</div>
      <div className="text-[10px] opacity-70">{label}</div>
    </div>
  );
}
