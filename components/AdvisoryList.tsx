'use client';

import { SeverityBadge } from './SeverityBadge';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

interface Advisory {
  id: string;
  ghsaId: string;
  cveId: string | null;
  severity: Severity;
  summary: string;
  packageName: string;
  ecosystem: string;
  vulnerableRange: string | null;
  fixedVersion: string | null;
  publishedAt: string | null;
  url: string | null;
}

interface AdvisoryListProps {
  advisories: Advisory[];
}

export function AdvisoryList({ advisories }: AdvisoryListProps) {
  if (advisories.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p className="text-lg">✅ Keine CVEs gefunden</p>
        <p className="text-sm mt-1">Dieses Repository hat keine bekannten Schwachstellen.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {advisories.map((advisory) => (
        <div
          key={advisory.id}
          className="bg-white rounded-lg border border-gray-200 p-4 hover:border-gray-300 transition-colors"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <SeverityBadge severity={advisory.severity} />
                <span className="font-mono text-sm text-gray-600">{advisory.packageName}</span>
                <span className="text-xs text-gray-400">{advisory.ecosystem}</span>
              </div>
              <p className="mt-1 text-sm text-gray-800 line-clamp-2">{advisory.summary}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                {advisory.cveId && <span>🔖 {advisory.cveId}</span>}
                <span>📋 {advisory.ghsaId}</span>
                {advisory.vulnerableRange && (
                  <span>⚠️ Betroffen: {advisory.vulnerableRange}</span>
                )}
                {advisory.fixedVersion && (
                  <span className="text-green-600">✅ Fix: {advisory.fixedVersion}</span>
                )}
              </div>
            </div>
            {advisory.url && (
              <a
                href={advisory.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-xs text-blue-600 hover:underline"
              >
                Details →
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
