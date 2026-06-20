'use client';

import { useState, useMemo } from 'react';
import { useLocale, interpolate } from '@/lib/i18n';

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
  const { t } = useLocale();
  const [showAllLicenses, setShowAllLicenses] = useState(false);
  const [search, setSearch] = useState('');

  const {
    allSortedLicenses,
    hasMoreLicenses,
    filteredViolations,
    filteredNeedsReview,
    filteredCompatible,
  } = useMemo(() => {
    const sorted = Object.entries(summary).sort(([, a], [, b]) => b - a);

    const violations = licenses.filter((l) => l.policyViolation);
    const needsReview = licenses.filter((l) => !l.policyViolation && l.needsReview);
    const compatible = licenses.filter(
      (l) => !l.policyViolation && !l.needsReview && l.isCompatible,
    );

    const q = search.trim().toLowerCase();
    const match = (l: LicenseEntry) => !q || l.packageName.toLowerCase().includes(q);

    return {
      allSortedLicenses: sorted,
      hasMoreLicenses: sorted.length > 8,
      filteredViolations: violations.filter(match),
      filteredNeedsReview: needsReview.filter(match),
      filteredCompatible: compatible.filter(match),
    };
  }, [licenses, summary, search]);

  const displayedLicenses = showAllLicenses ? allSortedLicenses : allSortedLicenses.slice(0, 8);

  const isSearchActive = search.trim().length > 0;
  const noMatches =
    isSearchActive &&
    filteredViolations.length === 0 &&
    filteredNeedsReview.length === 0 &&
    filteredCompatible.length === 0;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400">{t['license.title']}</h3>
          {conflictCount > 0 ? (
            <span className="text-xs font-medium text-red-400 bg-red-950/50 px-2 py-0.5 rounded border border-red-900/50">
              {interpolate(t['license.conflicts'], { count: conflictCount })}
            </span>
          ) : (
            <span className="text-xs font-medium text-emerald-400 bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-900/50">
              {t['license.noConflicts']}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {displayedLicenses.map(([license, count]) => (
            <span
              key={license}
              className="inline-flex items-center gap-1 px-2 py-1 bg-gray-800 text-gray-400 text-xs rounded"
            >
              <span className="font-mono">{license}</span>
              <span className="text-gray-600">&times;{count}</span>
            </span>
          ))}
        </div>
        {hasMoreLicenses && (
          <button
            onClick={() => setShowAllLicenses((v) => !v)}
            className="mt-2 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            {showAllLicenses ? t['filter.showLess'] : t['filter.showAll']}
          </button>
        )}
      </div>

      {/* Package search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t['filter.search']}
        className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 transition-colors"
      />

      {/* No-match state */}
      {noMatches && (
        <div className="text-center py-8 text-gray-600 text-sm">{t['filter.noMatches']}</div>
      )}

      {/* Policy violations */}
      {filteredViolations.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-red-400 mb-2 uppercase tracking-wider">
            {t['license.violations']}
          </h4>
          <div className="space-y-1">
            {filteredViolations.map((l) => (
              <LicenseRow key={l.id} entry={l} />
            ))}
          </div>
        </div>
      )}

      {/* Needs review */}
      {filteredNeedsReview.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-yellow-400 mb-2 uppercase tracking-wider">
            {t['license.review']}
          </h4>
          <div className="space-y-1">
            {filteredNeedsReview.map((l) => (
              <LicenseRow key={l.id} entry={l} />
            ))}
          </div>
        </div>
      )}

      {/* Compatible */}
      {filteredCompatible.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">
            {interpolate(t['license.compatible'], { count: filteredCompatible.length })}
          </h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {filteredCompatible.map((l) => (
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
