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
    aggregate.overallHealthScore >= 70 ? 'text-green-600' :
    aggregate.overallHealthScore >= 40 ? 'text-yellow-600' : 'text-red-600';

  const riskColor =
    aggregate.avgRiskScore >= 70 ? 'text-red-600' :
    aggregate.avgRiskScore >= 40 ? 'text-orange-500' :
    aggregate.avgRiskScore >= 10 ? 'text-yellow-500' : 'text-green-600';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold text-gray-900">🏥 Team Health Overview</h2>
        <div className="text-right">
          <div className={`text-3xl font-bold ${healthColor}`}>
            {aggregate.overallHealthScore}
          </div>
          <div className="text-xs text-gray-500">Overall Health Score</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Repos */}
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-800">{aggregate.scannedRepos}/{aggregate.totalRepos}</div>
          <div className="text-xs text-gray-500">Repos gescannt</div>
        </div>

        {/* Avg Risk */}
        <div className="bg-gray-50 rounded-lg p-3">
          <div className={`text-2xl font-bold ${riskColor}`}>{aggregate.avgRiskScore}</div>
          <div className="text-xs text-gray-500">Ø Risk Score</div>
        </div>

        {/* CVEs */}
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-2xl font-bold text-gray-800">{aggregate.totalCVEs}</div>
          <div className="text-xs text-gray-500">CVEs gesamt</div>
          {aggregate.totalCritical > 0 && (
            <div className="text-xs text-red-600 mt-1">🔴 {aggregate.totalCritical} kritisch</div>
          )}
        </div>

        {/* License Issues */}
        <div className="bg-gray-50 rounded-lg p-3">
          <div className={`text-2xl font-bold ${aggregate.totalLicenseIssues > 0 ? 'text-red-600' : 'text-green-600'}`}>
            {aggregate.totalLicenseIssues}
          </div>
          <div className="text-xs text-gray-500">Lizenz-Konflikte</div>
        </div>
      </div>

      {/* Risk distribution */}
      <div className="mt-4">
        <div className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Risiko-Verteilung</div>
        <div className="flex gap-2">
          {[
            { label: 'Kritisch', count: aggregate.highRiskRepos, color: 'bg-red-100 text-red-700 border-red-200' },
            { label: 'Mittel', count: aggregate.mediumRiskRepos, color: 'bg-orange-100 text-orange-700 border-orange-200' },
            { label: 'Niedrig', count: aggregate.lowRiskRepos, color: 'bg-green-100 text-green-700 border-green-200' },
          ].map(({ label, count, color }) => (
            <div key={label} className={`flex-1 rounded-lg border px-3 py-2 text-center ${color}`}>
              <div className="text-lg font-bold">{count}</div>
              <div className="text-xs">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
