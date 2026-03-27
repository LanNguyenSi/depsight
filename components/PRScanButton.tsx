'use client';

import { useState } from 'react';

interface PRScanButtonProps {
  owner: string;
  repo: string;
}

interface ScanResult {
  commented: boolean;
  newCVECount: number;
  commentUrl: string | null;
}

export function PRScanButton({ owner, repo }: PRScanButtonProps) {
  const [open, setOpen] = useState(false);
  const [prNumber, setPrNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    const num = parseInt(prNumber, 10);
    if (!num || num < 1) {
      setError('Bitte eine gültige PR-Nummer eingeben.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/pr-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo, prNumber: num }),
      });
      const data = await res.json() as ScanResult & { error?: string };

      if (!res.ok) {
        setError(data.error ?? 'Scan fehlgeschlagen');
        return;
      }
      setResult(data);
    } catch {
      setError('Netzwerkfehler');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setResult(null); setError(null); }}
        className="px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
      >
        🔀 PR Scan
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">🔀 PR CVE Scan</h3>
            <p className="text-sm text-gray-500 mb-4">
              Scannt <span className="font-mono text-gray-700">{owner}/{repo}</span> und postet das Ergebnis als PR-Kommentar.
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pull Request Nummer
              </label>
              <input
                type="number"
                min={1}
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="z.B. 42"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                onKeyDown={(e) => e.key === 'Enter' && void handleScan()}
              />
            </div>

            {error && (
              <div className="mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                ❌ {error}
              </div>
            )}

            {result && (
              <div className="mb-3 text-sm bg-green-50 rounded-lg px-3 py-2">
                <div className="font-semibold text-green-700">
                  {result.newCVECount > 0
                    ? `⚠️ ${result.newCVECount} neue CVE(s) gefunden`
                    : '✅ Keine neuen CVEs'}
                </div>
                {result.commented && result.commentUrl && (
                  <a href={result.commentUrl} target="_blank" rel="noopener noreferrer"
                    className="text-green-600 underline text-xs mt-1 block">
                    Kommentar auf GitHub ansehen →
                  </a>
                )}
                {!result.commented && (
                  <p className="text-xs text-gray-500 mt-1">Kein Kommentar gepostet (PR möglicherweise nicht gefunden).</p>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                Abbrechen
              </button>
              <button
                onClick={() => void handleScan()}
                disabled={loading || !prNumber}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {loading ? '⏳ Scanne...' : '🔍 Scan starten'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
