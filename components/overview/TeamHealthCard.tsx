'use client';

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
        <h2 className="text-base font-semibold text-white">Team Health Overview</h2>
        <div className="text-right">
          <div className={`text-3xl font-bold tabular-nums ${healthColor}`}>
            {aggregate.overallHealthScore}
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Health Score</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-200 tabular-nums">{aggregate.scannedRepos}/{aggregate.totalRepos}</div>
          <div className="text-xs text-gray-500">Repos gescannt</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className={`text-2xl font-bold tabular-nums ${riskColor}`}>{aggregate.avgRiskScore}</div>
          <div className="text-xs text-gray-500">&Oslash; Risk Score</div>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-200 tabular-nums">{aggregate.totalCVEs}</div>
          <div className="text-xs text-gray-500">CVEs gesamt</div>
          {aggregate.totalCritical > 0 && (
            <div className="text-xs text-red-400 mt-1">{aggregate.totalCritical} kritisch</div>
          )}
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className={`text-2xl font-bold tabular-nums ${aggregate.totalLicenseIssues > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {aggregate.totalLicenseIssues}
          </div>
          <div className="text-xs text-gray-500">Lizenz-Konflikte</div>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[10px] font-semibold text-gray-500 mb-2 uppercase tracking-wider">Risiko-Verteilung</div>
        <div className="flex gap-2">
          {[
            { label: 'Kritisch', count: aggregate.highRiskRepos, cls: 'bg-red-950/50 text-red-400 border-red-900/50' },
            { label: 'Mittel', count: aggregate.mediumRiskRepos, cls: 'bg-orange-950/50 text-orange-400 border-orange-900/50' },
            { label: 'Niedrig', count: aggregate.lowRiskRepos, cls: 'bg-emerald-950/50 text-emerald-400 border-emerald-900/50' },
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
