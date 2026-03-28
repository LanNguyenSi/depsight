'use client';

import { useLocale } from '@/lib/i18n';
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
  const { t } = useLocale();

  if (advisories.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p className="text-sm font-medium text-emerald-400">{t['advisory.empty']}</p>
        <p className="text-xs mt-1 text-gray-600">{t['advisory.emptyDesc']}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {advisories.map((advisory) => (
        <div
          key={advisory.id}
          className="bg-gray-900 rounded-lg border border-gray-800 p-4 hover:border-gray-700 transition-colors"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <SeverityBadge severity={advisory.severity} />
                <span className="font-mono text-sm text-gray-300">{advisory.packageName}</span>
                <span className="text-xs text-gray-600">{advisory.ecosystem}</span>
              </div>
              <p className="mt-1.5 text-sm text-gray-400 line-clamp-2">{advisory.summary}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                {advisory.cveId && <span>{advisory.cveId}</span>}
                <span className="text-gray-700">{advisory.ghsaId}</span>
                {advisory.vulnerableRange && (
                  <span>{t['advisory.affected']} <span className="text-gray-500">{advisory.vulnerableRange}</span></span>
                )}
                {advisory.fixedVersion && (
                  <span className="text-emerald-500">{t['advisory.fix']} {advisory.fixedVersion}</span>
                )}
              </div>
            </div>
            {advisory.url && (
              <a
                href={advisory.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {t['advisory.details']}
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
