'use client';

import { useState } from 'react';
import { SeverityBreakdown } from '@/components/SeverityBreakdown';
import { AdvisoryList } from '@/components/AdvisoryList';
import { LicenseList } from '@/components/LicenseList';

interface ScanSummary {
  id: string;
  scannedAt: string;
  status: string;
  riskScore: number;
  counts: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

interface RepoItem {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  language: string | null;
  lastScannedAt: string | null;
  latestScan: ScanSummary | null;
}

interface ScanDetail {
  id: string;
  scannedAt: string;
  status: string;
  riskScore: number;
  counts: ScanSummary['counts'];
  advisories: {
    id: string;
    ghsaId: string;
    cveId: string | null;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    summary: string;
    packageName: string;
    ecosystem: string;
    vulnerableRange: string | null;
    fixedVersion: string | null;
    publishedAt: string | null;
    url: string | null;
  }[];
}

interface LicenseDetail {
  scanId: string;
  licenseCount: number;
  conflictCount: number;
  summary: Record<string, number>;
  licenses: {
    id: string;
    packageName: string;
    version: string;
    license: string;
    isCompatible: boolean;
    policyViolation: boolean;
  }[];
}

type ActiveTab = 'cve' | 'license';

interface DashboardClientProps {
  repos: RepoItem[];
}

export function DashboardClient({ repos: initialRepos }: DashboardClientProps) {
  const repos = initialRepos;
  const [selectedRepo, setSelectedRepo] = useState<RepoItem | null>(null);
  const [scanDetail, setScanDetail] = useState<ScanDetail | null>(null);
  const [licenseDetail, setLicenseDetail] = useState<LicenseDetail | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanningLicense, setScanningLicense] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('cve');

  async function handleSync() {
    setSyncing(true);
    try {
      await fetch('/api/repos/sync', { method: 'POST' });
      // Reload page to get updated repo list
      window.location.reload();
    } finally {
      setSyncing(false);
    }
  }

  async function handleCveScan(repo: RepoItem) {
    setScanning(true);
    setSelectedRepo(repo);
    setScanDetail(null);
    setActiveTab('cve');

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repo.id }),
      });
      if (!res.ok) throw new Error('Scan fehlgeschlagen');
      await loadScanDetail(repo.id);
    } catch (err) {
      console.error(err);
    } finally {
      setScanning(false);
    }
  }

  async function handleLicenseScan(repo: RepoItem) {
    setScanningLicense(true);
    setActiveTab('license');

    try {
      await fetch('/api/license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repo.id }),
      });
      await loadLicenseDetail(repo.id);
    } catch (err) {
      console.error(err);
    } finally {
      setScanningLicense(false);
    }
  }

  async function loadScanDetail(repoId: string) {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/scan?repoId=${repoId}`);
      const data = await res.json() as { scan: ScanDetail | null };
      setScanDetail(data.scan);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function loadLicenseDetail(repoId: string) {
    const res = await fetch(`/api/license?repoId=${repoId}`);
    const data = await res.json() as LicenseDetail;
    setLicenseDetail(data.licenses?.length > 0 ? data : null);
  }

  async function handleSelectRepo(repo: RepoItem) {
    setSelectedRepo(repo);
    setScanDetail(null);
    setLicenseDetail(null);
    if (repo.latestScan) {
      await loadScanDetail(repo.id);
      await loadLicenseDetail(repo.id);
    }
  }

  const riskColor = (score: number) =>
    score >= 70 ? 'text-red-600' : score >= 40 ? 'text-orange-500' : score >= 10 ? 'text-yellow-500' : 'text-green-600';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">🔍 depsight</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{repos.length} Repositories</span>
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {syncing ? '⏳ Sync...' : '🔄 Repos synchronisieren'}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 flex gap-6">
        {/* Repo list */}
        <aside className="w-72 shrink-0">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Repositories
          </h2>
          <div className="space-y-1">
            {repos.length === 0 && (
              <p className="text-sm text-gray-400 py-4 text-center">
                Keine Repos – bitte synchronisieren.
              </p>
            )}
            {repos.map((repo) => (
              <button
                key={repo.id}
                onClick={() => void handleSelectRepo(repo)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  selectedRepo?.id === repo.id
                    ? 'bg-blue-50 border border-blue-200 text-blue-800'
                    : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                <div className="font-medium truncate">{repo.fullName}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {repo.language && (
                    <span className="text-xs text-gray-400">{repo.language}</span>
                  )}
                  {repo.latestScan && (
                    <span className={`text-xs font-semibold ${riskColor(repo.latestScan.riskScore)}`}>
                      Risk: {repo.latestScan.riskScore}
                    </span>
                  )}
                  {!repo.latestScan && (
                    <span className="text-xs text-gray-400">Nicht gescannt</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Detail panel */}
        <main className="flex-1 min-w-0">
          {!selectedRepo && (
            <div className="flex items-center justify-center h-64 text-gray-400">
              <p>← Repository auswählen</p>
            </div>
          )}

          {selectedRepo && (
            <div className="space-y-4">
              {/* Repo header + actions */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">{selectedRepo.fullName}</h2>
                  {selectedRepo.lastScannedAt && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Zuletzt gescannt: {new Date(selectedRepo.lastScannedAt).toLocaleString('de-DE')}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleCveScan(selectedRepo)}
                    disabled={scanning}
                    className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {scanning ? '⏳' : '🔍'} CVE Scan
                  </button>
                  <button
                    onClick={() => void handleLicenseScan(selectedRepo)}
                    disabled={scanningLicense}
                    className="px-3 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
                  >
                    {scanningLicense ? '⏳' : '📋'} Lizenzen
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-gray-200">
                <button
                  onClick={() => setActiveTab('cve')}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'cve'
                      ? 'text-blue-600 border-b-2 border-blue-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  🔍 CVEs {scanDetail && `(${scanDetail.counts.total})`}
                </button>
                <button
                  onClick={() => setActiveTab('license')}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'license'
                      ? 'text-purple-600 border-b-2 border-purple-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  📋 Lizenzen {licenseDetail && `(${licenseDetail.licenseCount})`}
                </button>
              </div>

              {/* CVE Tab */}
              {activeTab === 'cve' && (
                <>
                  {(loadingDetail || scanning) && (
                    <div className="text-center py-8 text-gray-400">⏳ Lade CVE-Daten...</div>
                  )}
                  {scanDetail && !loadingDetail && (
                    <>
                      <SeverityBreakdown counts={scanDetail.counts} riskScore={scanDetail.riskScore} />
                      <div>
                        <h3 className="text-sm font-semibold text-gray-700 mb-2">
                          CVEs ({scanDetail.counts.total})
                        </h3>
                        <AdvisoryList advisories={scanDetail.advisories} />
                      </div>
                    </>
                  )}
                  {!scanDetail && !loadingDetail && !scanning && (
                    <div className="text-center py-8 text-gray-400">
                      Noch kein CVE-Scan – klicke auf &ldquo;🔍 CVE Scan&rdquo;.
                    </div>
                  )}
                </>
              )}

              {/* License Tab */}
              {activeTab === 'license' && (
                <>
                  {scanningLicense && (
                    <div className="text-center py-8 text-gray-400">⏳ Erkenne Lizenzen...</div>
                  )}
                  {licenseDetail && !scanningLicense && (
                    <LicenseList
                      licenses={licenseDetail.licenses}
                      summary={licenseDetail.summary}
                      conflictCount={licenseDetail.conflictCount}
                    />
                  )}
                  {!licenseDetail && !scanningLicense && (
                    <div className="text-center py-8 text-gray-400">
                      Noch kein Lizenz-Scan – klicke auf &ldquo;📋 Lizenzen&rdquo;.
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
