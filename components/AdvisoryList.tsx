'use client';

import { useState, useMemo } from 'react';
import { useLocale } from '@/lib/i18n';
import { SeverityBadge } from './SeverityBadge';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
type Source = 'dependabot' | 'osv';

interface Advisory {
  id: string;
  ghsaId: string;
  cveId: string | null;
  source: Source;
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

const FILTER_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
type FilterSeverity = (typeof FILTER_SEVERITIES)[number];

const SEVERITY_CHIP_STYLES: Record<FilterSeverity, string> = {
  CRITICAL: 'text-red-400 bg-red-950/50 border-red-900/50',
  HIGH: 'text-orange-400 bg-orange-950/50 border-orange-900/50',
  MEDIUM: 'text-yellow-400 bg-yellow-950/50 border-yellow-900/50',
  LOW: 'text-emerald-400 bg-emerald-950/50 border-emerald-900/50',
};

// Neutral badge, matching the existing UNKNOWN/status tag styling elsewhere
// (SeverityBadge, DependencyTable) — source is informational, not a risk axis.
const SOURCE_BADGE_STYLE = 'text-gray-500 bg-gray-800 border-gray-700';

export function AdvisoryList({ advisories }: AdvisoryListProps) {
  const { t } = useLocale();
  const [activeSeverities, setActiveSeverities] = useState<Set<Severity>>(
    () => new Set<Severity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
  );
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return advisories.filter((a) => {
      // UNKNOWN severities always pass the severity filter (no chip for them)
      const matchesSeverity = a.severity === 'UNKNOWN' || activeSeverities.has(a.severity);
      const matchesSearch =
        !q ||
        a.packageName.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q);
      return matchesSeverity && matchesSearch;
    });
  }, [advisories, activeSeverities, search]);

  const toggleSeverity = (s: FilterSeverity) => {
    setActiveSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) {
        next.delete(s);
      } else {
        next.add(s);
      }
      return next;
    });
  };

  const severityLabel = (s: FilterSeverity): string => {
    switch (s) {
      case 'CRITICAL': return t['severity.critical'];
      case 'HIGH': return t['severity.high'];
      case 'MEDIUM': return t['severity.medium'];
      case 'LOW': return t['severity.low'];
    }
  };

  const sourceLabel = (s: Source): string => {
    switch (s) {
      case 'dependabot': return t['advisory.source.dependabot'];
      case 'osv': return t['advisory.source.osv'];
    }
  };

  if (advisories.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p className="text-sm font-medium text-emerald-400">{t['advisory.empty']}</p>
        <p className="text-xs mt-1 text-gray-600">{t['advisory.emptyDesc']}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_SEVERITIES.map((s) => {
          const active = activeSeverities.has(s);
          return (
            <button
              key={s}
              onClick={() => toggleSeverity(s)}
              className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium transition-opacity ${SEVERITY_CHIP_STYLES[s]} ${active ? '' : 'opacity-30'}`}
            >
              {severityLabel(s)}
            </button>
          );
        })}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t['filter.search']}
          className="ml-auto min-w-0 w-48 bg-gray-900 border border-gray-800 rounded-lg px-3 py-1 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 transition-colors"
        />
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <div className="text-center py-8 text-gray-600 text-sm">{t['filter.noMatches']}</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((advisory) => (
            <div
              key={advisory.id}
              className="bg-gray-900 rounded-lg border border-gray-800 p-4 hover:border-gray-700 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SeverityBadge severity={advisory.severity} />
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${SOURCE_BADGE_STYLE}`}
                    >
                      {sourceLabel(advisory.source)}
                    </span>
                    <span className="font-mono text-sm text-gray-300">{advisory.packageName}</span>
                    <span className="text-xs text-gray-600">{advisory.ecosystem}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-gray-400 line-clamp-2">{advisory.summary}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                    {advisory.cveId && <span>{advisory.cveId}</span>}
                    <span className="text-gray-700">{advisory.ghsaId}</span>
                    {advisory.vulnerableRange && (
                      <span>
                        {t['advisory.affected']}{' '}
                        <span className="text-gray-500">{advisory.vulnerableRange}</span>
                      </span>
                    )}
                    {advisory.fixedVersion && (
                      <span className="text-emerald-500">
                        {t['advisory.fix']} {advisory.fixedVersion}
                      </span>
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
      )}
    </div>
  );
}
