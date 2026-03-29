'use client';

import { useState, useEffect, useCallback } from 'react';

interface WorkflowFailRate {
  workflowId: string;
  name: string;
  totalRuns: number;
  failedRuns: number;
  failRatePct: number;
  jobs: { jobName: string; failRatePct: number; totalRuns: number }[];
}

interface WorkflowBuildTimes {
  workflowId: string;
  name: string;
  overall: { p50: number | null; p95: number | null; sampleSize: number };
}

interface FlakyJob {
  jobName: string;
  workflowName: string;
  signal: string;
  failRatePct: number;
  shaRetryCount: number;
}

interface CIAnalytics {
  failRates: WorkflowFailRate[];
  buildTimes: WorkflowBuildTimes[];
  flakyJobs: FlakyJob[];
  lastRunAge: string | null;
}

interface Props {
  repoId: string;
}

type Period = 1 | 7 | 30;

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function HealthDot({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-green-500' : score >= 40 ? 'bg-yellow-500' : 'bg-red-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

export function CIHealthTab({ repoId }: Props) {
  const [period, setPeriod] = useState<Period>(30);
  const [analytics, setAnalytics] = useState<CIAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const [failRateRes, buildTimesRes, flakyRes] = await Promise.all([
        fetch(`/api/ci/analytics/${repoId}?type=fail-rate&period=${p}`),
        fetch(`/api/ci/analytics/${repoId}?type=build-times&period=${p}`),
        fetch(`/api/ci/analytics/${repoId}?type=flaky&period=${p}`),
      ]);

      const [frData, btData, flData] = await Promise.all([
        failRateRes.json(),
        buildTimesRes.json(),
        flakyRes.json(),
      ]);

      setAnalytics({
        failRates: frData.data ?? [],
        buildTimes: btData.data ?? [],
        flakyJobs: flData.data ?? [],
        lastRunAge: null,
      });
    } catch {
      setError('Failed to load CI data');
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    void fetchAnalytics(period);
  }, [fetchAnalytics, period]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/ci/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId }),
      });
      if (!res.ok) throw new Error('Sync failed');
      await fetchAnalytics(period);
    } catch {
      setError('Sync failed — check GitHub token permissions (actions:read required)');
    } finally {
      setSyncing(false);
    }
  }

  const overallFailRate = analytics?.failRates.length
    ? analytics.failRates.reduce((sum, w) => sum + w.failRatePct * w.totalRuns, 0) /
      analytics.failRates.reduce((sum, w) => sum + w.totalRuns, 0)
    : 0;

  const avgBuildTime = analytics?.buildTimes.length
    ? analytics.buildTimes[0]?.overall.p50 ?? null
    : null;

  const flakyCount = analytics?.flakyJobs.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">CI Health</h3>
        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(parseInt(e.target.value) as Period)}
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
          >
            <option value={1}>1d</option>
            <option value={7}>7d</option>
            <option value={30}>30d</option>
          </select>
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="text-xs px-3 py-1 rounded bg-blue-600/20 text-blue-400 border border-blue-600/40 hover:bg-blue-600/30 transition-colors disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="py-8 text-center text-xs text-gray-500">Loading CI data…</div>
      )}

      {!loading && analytics && analytics.failRates.length === 0 && (
        <div className="py-8 text-center">
          <p className="text-sm text-gray-500">No CI data yet.</p>
          <p className="text-xs text-gray-600 mt-1">
            Click &ldquo;Sync&rdquo; to import workflow runs from GitHub.
          </p>
        </div>
      )}

      {!loading && analytics && analytics.failRates.length > 0 && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div className="text-xs text-gray-500 mb-1">Fail Rate</div>
              <div className={`text-lg font-bold ${overallFailRate > 20 ? 'text-red-400' : overallFailRate > 10 ? 'text-yellow-400' : 'text-green-400'}`}>
                {isNaN(overallFailRate) ? '—' : `${Math.round(overallFailRate * 10) / 10}%`}
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div className="text-xs text-gray-500 mb-1">Build Time P50</div>
              <div className="text-lg font-bold text-gray-200">
                {formatDuration(avgBuildTime)}
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div className="text-xs text-gray-500 mb-1">Flaky Jobs</div>
              <div className={`text-lg font-bold ${flakyCount > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                {flakyCount}
              </div>
            </div>
          </div>

          {/* Workflows */}
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Workflows</div>
            <div className="space-y-1">
              {analytics.failRates.map((wf) => {
                const bt = analytics.buildTimes.find((b) => b.workflowId === wf.workflowId);
                const score = 100 - Math.min(40, wf.failRatePct * 0.8);
                return (
                  <div key={wf.workflowId} className="flex items-center gap-3 py-2 border-b border-gray-800/50">
                    <HealthDot score={score} />
                    <span className="text-xs text-gray-300 flex-1 font-mono truncate">{wf.name}</span>
                    <span className={`text-xs tabular-nums ${wf.failRatePct > 20 ? 'text-red-400' : wf.failRatePct > 10 ? 'text-yellow-400' : 'text-gray-400'}`}>
                      {wf.failRatePct}% fail
                    </span>
                    <span className="text-xs tabular-nums text-gray-500">
                      P50: {formatDuration(bt?.overall.p50 ?? null)}
                    </span>
                    <span className="text-xs tabular-nums text-gray-600">
                      P95: {formatDuration(bt?.overall.p95 ?? null)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Flaky Jobs */}
          {analytics.flakyJobs.length > 0 && (
            <div>
              <div className="text-xs font-medium text-yellow-500/70 uppercase tracking-wider mb-2">
                ⚠ Flaky Jobs
              </div>
              <div className="space-y-1">
                {analytics.flakyJobs.map((job, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5 text-xs">
                    <span className="text-yellow-400 font-mono">{job.jobName}</span>
                    <span className="text-gray-600">({job.workflowName})</span>
                    <span className="text-gray-500 ml-auto">
                      {job.signal === 'sha-retry'
                        ? `SHA-retry pattern (${job.shaRetryCount})`
                        : `${job.failRatePct}% fail rate`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
