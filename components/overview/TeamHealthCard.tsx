'use client';

import { useLocale } from '@/lib/i18n';

interface Aggregate {
  totalRepos: number;
  scannedRepos: number;
  avgRiskScore: number;
  totalCVEs: number;
  totalCritical: number;
  totalHigh: number;
  totalLicenseIssues: number;
  highRiskRepos: number;
  mediumRiskRepos: number;
  lowRiskRepos: number;
  overallHealthScore: number;
}

interface TeamHealthCardProps {
  aggregate: Aggregate;
}

export function TeamHealthCard({ aggregate }: TeamHealthCardProps) {
  const { t } = useLocale();

  if (aggregate.scannedRepos === 0) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
        <h2 className="text-base font-semibold text-white mb-4">{t['overview.teamHealth']}</h2>
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-300 mb-1">{t['overview.noScans']}</p>
          <p className="text-xs text-gray-500 mb-4">{t['overview.noScans.hint']}</p>
          <a
            href="/dashboard"
            className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
          >
            {t['overview.noScans.action']}
          </a>
        </div>
      </div>
    );
  }

  const healthColor =
    aggregate.overallHealthScore >= 70 ? 'text-emerald-400' :
    aggregate.overallHealthScore >= 40 ? 'text-yellow-400' : 'text-red-400';

  const riskColor =
    aggregate.avgRiskScore >= 70 ? 'text-red-400' :
    aggregate.avgRiskScore >= 40 ? 'text-orange-400' :
    aggregate.avgRiskScore >= 10 ? 'text-yellow-400' : 'text-emerald-400';

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-base font-semibold text-white">{t['overview.teamHealth']}</h2>
        <div className="text-right">
          <div className={`text-3xl font-bold tabular-nums ${healthColor}`}>
            {aggregate.overallHealthScore}
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">{t['overview.healthScore']}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-200 tabular-nums">{aggregate.scannedRepos}/{aggregate.totalRepos}</div>
          <div className="text-xs text-gray-500">{t['overview.reposScanned']}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className={`text-2xl font-bold tabular-nums ${riskColor}`}>{aggregate.avgRiskScore}</div>
          <div className="text-xs text-gray-500">{t['overview.avgRisk']}</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-200 tabular-nums">{aggregate.totalCVEs}</div>
          <div className="text-xs text-gray-500">{t['overview.totalCVEs']}</div>
          {aggregate.totalCritical > 0 && (
            <div className="text-xs text-red-400 mt-1">{aggregate.totalCritical} {t['overview.criticalCount']}</div>
          )}
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className={`text-2xl font-bold tabular-nums ${aggregate.totalLicenseIssues > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {aggregate.totalLicenseIssues}
          </div>
          <div className="text-xs text-gray-500">{t['overview.licenseIssues']}</div>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[10px] font-semibold text-gray-500 mb-2 uppercase tracking-wider">{t['overview.riskDistribution']}</div>
        <div className="flex gap-2">
          {[
            { label: t['overview.riskCritical'], count: aggregate.highRiskRepos, cls: 'bg-red-950/50 text-red-400 border-red-900/50' },
            { label: t['overview.riskMedium'], count: aggregate.mediumRiskRepos, cls: 'bg-orange-950/50 text-orange-400 border-orange-900/50' },
            { label: t['overview.riskLow'], count: aggregate.lowRiskRepos, cls: 'bg-emerald-950/50 text-emerald-400 border-emerald-900/50' },
          ].map(({ label, count, cls }) => (
            <div key={label} className={`flex-1 rounded-lg border px-3 py-2 text-center ${cls}`}>
              <div className="text-lg font-bold tabular-nums">{count}</div>
              <div className="text-[10px] opacity-70">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
