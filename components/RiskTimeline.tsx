'use client';

import { useLocale } from '@/lib/i18n';
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
  const { t } = useLocale();

  if (history.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
        {t['timeline.empty']}
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
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-4">{t['timeline.title']}</h3>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#6b7280' }}
            tickLine={{ stroke: '#374151' }}
            axisLine={{ stroke: '#374151' }}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: '#6b7280' }}
            tickLine={{ stroke: '#374151' }}
            axisLine={{ stroke: '#374151' }}
            width={30}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 text-xs">
                  <div className="font-medium text-gray-300 mb-1.5">{d.fullDate}</div>
                  <div className="space-y-1">
                    <div className="flex justify-between gap-6">
                      <span className="text-gray-500">{t['timeline.riskScore']}</span>
                      <span className={`font-bold tabular-nums ${
                        d.riskScore >= 70 ? 'text-red-400' :
                        d.riskScore >= 40 ? 'text-orange-400' :
                        d.riskScore >= 10 ? 'text-yellow-400' : 'text-emerald-400'
                      }`}>{d.riskScore}</span>
                    </div>
                    <div className="flex justify-between gap-6">
                      <span className="text-gray-500">{t['timeline.cves']}</span>
                      <span className="text-gray-300 tabular-nums">{d.cveCount}</span>
                    </div>
                    <div className="flex justify-between gap-6">
                      <span className="text-gray-500">{t['timeline.critical']}</span>
                      <span className="text-red-400 tabular-nums">{d.critical}</span>
                    </div>
                    <div className="flex justify-between gap-6">
                      <span className="text-gray-500">{t['timeline.high']}</span>
                      <span className="text-orange-400 tabular-nums">{d.high}</span>
                    </div>
                  </div>
                </div>
              );
            }}
          />
          <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="5 5" opacity={0.3} />
          <ReferenceLine y={40} stroke="#f97316" strokeDasharray="5 5" opacity={0.3} />
          <ReferenceLine y={10} stroke="#eab308" strokeDasharray="5 5" opacity={0.3} />

          <Line
            type="monotone"
            dataKey="riskScore"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ fill: '#3b82f6', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#60a5fa' }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex justify-center gap-6 mt-3 text-[10px] text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-px bg-red-400/50 inline-block" /> {t['timeline.legendCritical']}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-px bg-orange-400/50 inline-block" /> {t['timeline.legendHigh']}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-px bg-yellow-400/50 inline-block" /> {t['timeline.legendMedium']}
        </span>
      </div>
    </div>
  );
}
