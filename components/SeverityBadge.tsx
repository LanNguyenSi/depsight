'use client';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: 'bg-red-950/60 text-red-400 border-red-900/50',
  HIGH: 'bg-orange-950/60 text-orange-400 border-orange-900/50',
  MEDIUM: 'bg-yellow-950/60 text-yellow-400 border-yellow-900/50',
  LOW: 'bg-blue-950/60 text-blue-400 border-blue-900/50',
  UNKNOWN: 'bg-gray-800 text-gray-500 border-gray-700',
};

interface SeverityBadgeProps {
  severity: Severity;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${SEVERITY_STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}
