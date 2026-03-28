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
      const data = (await res.json()) as ScanResult & { error?: string };

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
        onClick={() => {
          setOpen(true);
          setResult(null);
          setError(null);
        }}
        className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-md hover:bg-gray-700 transition-colors border border-gray-700"
      >
        PR Scan
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-white mb-1">PR CVE Scan</h3>
            <p className="text-sm text-gray-500 mb-4">
              Scannt{' '}
              <span className="font-mono text-gray-400">
                {owner}/{repo}
              </span>{' '}
              und postet das Ergebnis als PR-Kommentar.
            </p>

            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                Pull Request Nummer
              </label>
              <input
                type="number"
                min={1}
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="z.B. 42"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                onKeyDown={(e) => e.key === 'Enter' && void handleScan()}
              />
            </div>

            {error && (
              <div className="mb-3 text-sm text-red-400 bg-red-950/50 border border-red-900/50 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {result && (
              <div className="mb-3 text-sm bg-emerald-950/50 border border-emerald-900/50 rounded-lg px-3 py-2">
                <div className="font-medium text-emerald-400">
                  {result.newCVECount > 0
                    ? `${result.newCVECount} neue CVE(s) gefunden`
                    : 'Keine neuen CVEs'}
                </div>
                {result.commented && result.commentUrl && (
                  <a
                    href={result.commentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 text-xs mt-1 block transition-colors"
                  >
                    Kommentar auf GitHub ansehen &rarr;
                  </a>
                )}
                {!result.commented && (
                  <p className="text-xs text-gray-500 mt-1">
                    Kein Kommentar gepostet.
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={() => void handleScan()}
                disabled={loading || !prNumber}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Scanne...' : 'Scan starten'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
