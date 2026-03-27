'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

interface ScanHistoryPoint {
  scannedAt: string;
  riskScore: number;
  cveCount: number;
  criticalCount: number;
  highCount: number;
}

interface RiskTimelineProps {
  history: ScanHistoryPoint[];
  height?: number;
}

export function RiskTimeline({ history, height = 200 }: RiskTimelineProps) {
  if (history.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
        Keine Scan-Historie vorhanden
      </div>
    );
  }

  const data = history.map((point) => ({
    date: new Date(point.scannedAt).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
    }),
    fullDate: new Date(point.scannedAt).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    riskScore: point.riskScore,
    cveCount: point.cveCount,
    critical: point.criticalCount,
    high: point.highCount,
  }));

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        📈 Risiko-Verlauf
      </h3>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickLine={{ stroke: '#e5e7eb' }}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickLine={{ stroke: '#e5e7eb' }}
            width={35}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as typeof data[number];
              return (
                <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs">
                  <div className="font-semibold text-gray-800 mb-1">{d.fullDate}</div>
                  <div className="space-y-0.5">
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-500">Risk Score:</span>
                      <span className={`font-bold ${
                        d.riskScore >= 70 ? 'text-red-600' :
                        d.riskScore >= 40 ? 'text-orange-500' :
                        d.riskScore >= 10 ? 'text-yellow-600' : 'text-green-600'
                      }`}>{d.riskScore}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-500">CVEs:</span>
                      <span className="text-gray-800">{d.cveCount}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-500">Critical:</span>
                      <span className="text-red-600">{d.critical}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-500">High:</span>
                      <span className="text-orange-500">{d.high}</span>
                    </div>
                  </div>
                </div>
              );
            }}
          />
          {/* Risk threshold lines */}
          <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="5 5" opacity={0.5} />
          <ReferenceLine y={40} stroke="#f97316" strokeDasharray="5 5" opacity={0.5} />
          <ReferenceLine y={10} stroke="#eab308" strokeDasharray="5 5" opacity={0.5} />
          
          <Line
            type="monotone"
            dataKey="riskScore"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ fill: '#3b82f6', strokeWidth: 0, r: 4 }}
            activeDot={{ r: 6, fill: '#2563eb' }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex justify-center gap-4 mt-2 text-xs text-gray-400">
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 bg-red-400 inline-block" /> &gt;70 Kritisch
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 bg-orange-400 inline-block" /> &gt;40 Hoch
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 bg-yellow-400 inline-block" /> &gt;10 Mittel
        </span>
      </div>
    </div>
  );
}
