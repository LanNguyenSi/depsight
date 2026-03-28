'use client';

import { useState, useMemo, useCallback } from 'react';
import { useLocale, interpolate } from '@/lib/i18n';
import { AppShell } from '@/components/AppShell';
import { PRScanButton } from '@/components/PRScanButton';
import { SeverityBreakdown } from '@/components/SeverityBreakdown';
import { AdvisoryList } from '@/components/AdvisoryList';
import { LicenseList } from '@/components/LicenseList';
import { RiskTimeline } from '@/components/RiskTimeline';
import { DependencyTable } from '@/components/DependencyTable';

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

interface UnsupportedEcosystem {
  ecosystem: string;
  label: string;
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
  unsupportedEcosystem?: UnsupportedEcosystem;
}

interface ScanHistoryPoint {
  scannedAt: string;
  riskScore: number;
  cveCount: number;
  criticalCount: number;
  highCount: number;
}

type DepStatus = 'UP_TO_DATE' | 'OUTDATED' | 'MAJOR_BEHIND' | 'DEPRECATED' | 'UNKNOWN';

interface DepSummary {
  total: number;
  upToDate: number;
  outdated: number;
  majorBehind: number;
  deprecated: number;
  unknown: number;
}

interface DepEntry {
  id: string;
  name: string;
  installedVersion: string;
  latestVersion: string;
  ageInDays: number | null;
  status: DepStatus;
  isDeprecated: boolean;
  updateAvailable: boolean;
}

interface DepsDetail {
  scanId: string;
  summary: DepSummary;
  dependencies: DepEntry[];
  unsupportedEcosystem?: UnsupportedEcosystem;
}

type ActiveTab = 'cve' | 'license' | 'deps' | 'history';
type SortKey = 'name' | 'risk' | 'language';

interface DashboardClientProps {
  repos: RepoItem[];
  initialRepoId?: string | null;
}

const riskColor = (score: number) =>
  score >= 70
    ? 'text-red-400'
    : score >= 40
      ? 'text-orange-400'
      : score >= 10
        ? 'text-yellow-400'
        : 'text-emerald-400';

export function DashboardClient({ repos: initialRepos, initialRepoId }: DashboardClientProps) {
  const repos = initialRepos;
  const { t, locale } = useLocale();

  const TABS: { key: ActiveTab; label: string }[] = [
    { key: 'cve', label: t['dashboard.tab.cve'] },
    { key: 'license', label: t['dashboard.tab.license'] },
    { key: 'deps', label: t['dashboard.tab.deps'] },
    { key: 'history', label: t['dashboard.tab.history'] },
  ];
  const [selectedRepo, setSelectedRepo] = useState<RepoItem | null>(
    initialRepoId ? repos.find((r) => r.id === initialRepoId) ?? null : null,
  );
  const [scanDetail, setScanDetail] = useState<ScanDetail | null>(null);
  const [licenseDetail, setLicenseDetail] = useState<LicenseDetail | null>(null);
  const [depsDetail, setDepsDetail] = useState<DepsDetail | null>(null);
  const [scanHistory, setScanHistory] = useState<ScanHistoryPoint[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanningLicense, setScanningLicense] = useState(false);
  const [scanningDeps, setScanningDeps] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('cve');
  const [dependabotDisabled, setDependabotDisabled] = useState(false);
  const [enablingDependabot, setEnablingDependabot] = useState(false);

  const [sbomError, setSbomError] = useState<string | null>(null);

  // Filter & sort
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('name');

  const filteredRepos = useMemo(() => {
    let list = repos;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          (r.language?.toLowerCase().includes(q) ?? false),
      );
    }
    return [...list].sort((a, b) => {
      if (sortBy === 'risk') {
        const aScore = a.latestScan?.riskScore ?? -1;
        const bScore = b.latestScan?.riskScore ?? -1;
        return bScore - aScore;
      }
      if (sortBy === 'language') {
        return (a.language ?? '').localeCompare(b.language ?? '');
      }
      return a.fullName.localeCompare(b.fullName);
    });
  }, [repos, search, sortBy]);

  async function handleSync() {
    setSyncing(true);
    try {
      await fetch('/api/repos/sync', { method: 'POST' });
      window.location.reload();
    } finally {
      setSyncing(false);
    }
  }

  async function handleCveScan(repo: RepoItem) {
    setScanning(true);
    setSelectedRepo(repo);
    setScanDetail(null);
    setDependabotDisabled(false);
    setActiveTab('cve');
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repo.id }),
      });
      if (!res.ok) throw new Error('Scan fehlgeschlagen');
      const data = (await res.json()) as { scanId: string; dependabotDisabled?: boolean };
      if (data.dependabotDisabled) {
        setDependabotDisabled(true);
      } else {
        await loadScanDetail(repo.id);
        await loadScanHistory(repo.id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setScanning(false);
    }
  }

  async function handleEnableDependabot(repo: RepoItem) {
    setEnablingDependabot(true);
    try {
      const res = await fetch('/api/dependabot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repo.id }),
      });
      if (res.ok) {
        setDependabotDisabled(false);
        await handleCveScan(repo);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setEnablingDependabot(false);
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

  async function handleDepsScan(repo: RepoItem) {
    setScanningDeps(true);
    setActiveTab('deps');
    try {
      await fetch('/api/deps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repo.id }),
      });
      await loadDepsDetail(repo.id);
    } catch (err) {
      console.error(err);
    } finally {
      setScanningDeps(false);
    }
  }

  async function loadScanDetail(repoId: string) {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/scan?repoId=${repoId}`);
      const data = (await res.json()) as { scan: ScanDetail | null };
      setScanDetail(data.scan);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function loadLicenseDetail(repoId: string) {
    const res = await fetch(`/api/license?repoId=${repoId}`);
    const data = (await res.json()) as LicenseDetail;
    setLicenseDetail(data.licenses?.length > 0 || data.unsupportedEcosystem ? data : null);
  }

  async function loadDepsDetail(repoId: string) {
    const res = await fetch(`/api/deps?repoId=${repoId}`);
    const data = (await res.json()) as DepsDetail;
    setDepsDetail(data.dependencies?.length > 0 || data.unsupportedEcosystem ? data : null);
  }

  async function loadScanHistory(repoId: string) {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/history?repoId=${repoId}&limit=30`);
      const data = (await res.json()) as { history: ScanHistoryPoint[] };
      setScanHistory(data.history ?? []);
    } finally {
      setLoadingHistory(false);
    }
  }

  const handleSbomDownload = useCallback(async (repo: RepoItem) => {
    setSbomError(null);
    const res = await fetch(`/api/sbom?repoId=${repo.id}`);
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? 'sbom.cdx.json';
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const data = (await res.json()) as { error?: string; message?: string };
      if (data.error === 'no_scan') {
        setSbomError(data.message ?? t['dashboard.sbom.noScan']);
      } else {
        setSbomError(data.message ?? 'SBOM-Export fehlgeschlagen.');
      }
    }
  }, []);

  async function handleSelectRepo(repo: RepoItem) {
    setSelectedRepo(repo);
    setScanDetail(null);
    setLicenseDetail(null);
    setDepsDetail(null);
    setScanHistory([]);
    setDependabotDisabled(false);
    setSbomError(null);
    if (repo.latestScan) {
      await Promise.all([
        loadScanDetail(repo.id),
        loadLicenseDetail(repo.id),
        loadDepsDetail(repo.id),
        loadScanHistory(repo.id),
      ]);
    }
  }

  return (
    <AppShell repoCount={repos.length}>
      <div className="flex gap-6 items-start">
        {/* Sidebar — repo list */}
        <aside className="w-72 shrink-0 sticky top-20 max-h-[calc(100vh-6rem)] flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {t['dashboard.repos']}
            </h2>
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors"
            >
              {syncing ? t['dashboard.syncing'] : t['dashboard.sync']}
            </button>
          </div>

          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t['dashboard.search']}
            className="w-full bg-gray-900 border border-gray-800 rounded-md px-3 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-700 transition-colors mb-2"
          />

          {/* Sort */}
          <div className="flex gap-1 mb-2">
            {([
              ['name', t['dashboard.sort.name']],
              ['risk', t['dashboard.sort.risk']],
              ['language', t['dashboard.sort.language']],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                  sortBy === key
                    ? 'bg-gray-800 text-gray-300'
                    : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Repo list (scrollable) */}
          <div className="overflow-y-auto flex-1 space-y-0.5 -mr-2 pr-2">
            {filteredRepos.length === 0 && repos.length > 0 && (
              <p className="text-xs text-gray-600 py-4 text-center">{t['dashboard.noMatches']}</p>
            )}
            {repos.length === 0 && (
              <p className="text-sm text-gray-600 py-8 text-center">
                {t['dashboard.noRepos']}
              </p>
            )}
            {filteredRepos.map((repo) => (
              <button
                key={repo.id}
                onClick={() => void handleSelectRepo(repo)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  selectedRepo?.id === repo.id
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
                }`}
              >
                <div className="font-medium truncate">{repo.fullName}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {repo.language && (
                    <span className="text-xs text-gray-600">{repo.language}</span>
                  )}
                  {repo.latestScan && (
                    <span className={`text-xs font-medium tabular-nums ${riskColor(repo.latestScan.riskScore)}`}>
                      {repo.latestScan.riskScore}
                    </span>
                  )}
                  {!repo.latestScan && (
                    <span className="text-xs text-gray-700">{t['dashboard.notScanned']}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Detail panel */}
        <section className="flex-1 min-w-0">
          {!selectedRepo && (
            <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
              {t['dashboard.selectRepo']}
            </div>
          )}

          {selectedRepo && (
            <div className="space-y-4">
              {/* Repo header + actions — sticky */}
              <div className="sticky top-20 z-30 bg-gray-950 pb-3 -mt-2 pt-2">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-white">{selectedRepo.fullName}</h2>
                    {selectedRepo.lastScannedAt && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {t['dashboard.lastScanned']}{' '}
                        {new Date(selectedRepo.lastScannedAt).toLocaleString('de-DE')}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0 flex-wrap justify-end">
                    <button
                      onClick={() => void handleCveScan(selectedRepo)}
                      disabled={scanning}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
                    >
                      {scanning ? t['dashboard.btn.scanning'] : t['dashboard.btn.cveScan']}
                    </button>
                    <button
                      onClick={() => void handleLicenseScan(selectedRepo)}
                      disabled={scanningLicense}
                      className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-md hover:bg-gray-700 disabled:opacity-50 transition-colors border border-gray-700"
                    >
                      {scanningLicense ? t['dashboard.btn.scanning'] : t['dashboard.btn.license']}
                    </button>
                    <button
                      onClick={() => void handleDepsScan(selectedRepo)}
                      disabled={scanningDeps}
                      className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-md hover:bg-gray-700 disabled:opacity-50 transition-colors border border-gray-700"
                    >
                      {scanningDeps ? t['dashboard.btn.scanning'] : t['dashboard.btn.deps']}
                    </button>
                    <PRScanButton owner={selectedRepo.owner} repo={selectedRepo.name} />
                    <button
                      onClick={() => void handleSbomDownload(selectedRepo)}
                      className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-md hover:bg-gray-700 transition-colors border border-gray-700"
                    >
                      SBOM
                    </button>
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 border-b border-gray-800 mt-3">
                  {TABS.map(({ key, label }) => {
                    const count =
                      key === 'cve' ? scanDetail?.counts.total :
                      key === 'license' ? licenseDetail?.licenseCount :
                      key === 'deps' ? depsDetail?.summary.total :
                      scanHistory.length || undefined;
                    return (
                      <button
                        key={key}
                        onClick={() => setActiveTab(key)}
                        className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                          activeTab === key
                            ? 'text-blue-400 border-blue-400'
                            : 'text-gray-500 border-transparent hover:text-gray-300'
                        }`}
                      >
                        {label}
                        {count !== undefined && count > 0 && (
                          <span className="ml-1.5 text-gray-600 tabular-nums">{count}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* SBOM error notice */}
              {sbomError && (
                <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-orange-300">{sbomError}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Starte zuerst einen CVE-Scan, damit die SBOM Vulnerability-Daten enthält.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSbomError(null);
                      if (selectedRepo) void handleCveScan(selectedRepo);
                    }}
                    className="shrink-0 text-xs font-medium px-3 py-1.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/40 hover:bg-orange-500/30 transition-colors"
                  >
                    CVE Scan starten
                  </button>
                </div>
              )}

              {/* Tab content */}
              <div>
                {activeTab === 'cve' && (
                  <>
                    {(loadingDetail || scanning) && <Loading text={t['dashboard.loading.cve']} />}
                    {scanDetail && !loadingDetail && (
                      <>
                        <SeverityBreakdown counts={scanDetail.counts} riskScore={scanDetail.riskScore} />
                        <div className="mt-4">
                          <AdvisoryList advisories={scanDetail.advisories} />
                        </div>
                      </>
                    )}
                    {dependabotDisabled && selectedRepo && (
                      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
                        <div>
                          <p className="text-sm font-medium text-yellow-300">{t['dashboard.dependabot.disabled']}</p>
                          <p className="text-xs text-gray-400 mt-1">
                            {t['dashboard.dependabot.prompt']}
                          </p>
                        </div>
                        <button
                          onClick={() => void handleEnableDependabot(selectedRepo)}
                          disabled={enablingDependabot}
                          className="text-xs font-medium px-3 py-1.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
                        >
                          {enablingDependabot ? t['dashboard.dependabot.enabling'] : t['dashboard.dependabot.enable']}
                        </button>
                      </div>
                    )}
                    {!scanDetail && !loadingDetail && !scanning && !dependabotDisabled && (
                      <EmptyState text={t['dashboard.empty.cve']} />
                    )}
                  </>
                )}

                {activeTab === 'license' && (
                  <>
                    {scanningLicense && <Loading text={t['dashboard.loading.license']} />}
                    {licenseDetail?.unsupportedEcosystem && !scanningLicense && (
                      <EcosystemNotice label={licenseDetail.unsupportedEcosystem.label} />
                    )}
                    {licenseDetail && !licenseDetail.unsupportedEcosystem && !scanningLicense && (
                      <LicenseList
                        licenses={licenseDetail.licenses}
                        summary={licenseDetail.summary}
                        conflictCount={licenseDetail.conflictCount}
                      />
                    )}
                    {!licenseDetail && !scanningLicense && (
                      <EmptyState text={t['dashboard.empty.license']} />
                    )}
                  </>
                )}

                {activeTab === 'deps' && (
                  <>
                    {scanningDeps && <Loading text={t['dashboard.loading.deps']} />}
                    {depsDetail?.unsupportedEcosystem && !scanningDeps && (
                      <EcosystemNotice label={depsDetail.unsupportedEcosystem.label} />
                    )}
                    {depsDetail && !depsDetail.unsupportedEcosystem && !scanningDeps && (
                      <DependencyTable dependencies={depsDetail.dependencies} summary={depsDetail.summary} />
                    )}
                    {!depsDetail && !scanningDeps && (
                      <EmptyState text={t['dashboard.empty.deps']} />
                    )}
                  </>
                )}

                {activeTab === 'history' && (
                  <>
                    {loadingHistory && <Loading text={t['dashboard.loading.history']} />}
                    {!loadingHistory && <RiskTimeline history={scanHistory} height={250} />}
                    {!loadingHistory && scanHistory.length === 0 && (
                      <p className="text-center py-4 text-gray-600 text-xs">
                        {t['dashboard.empty.history']}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-12 gap-2 text-gray-500 text-sm">
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      {text}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="text-center py-12 text-gray-600 text-sm">{text}</div>;
}

function EcosystemNotice({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
      <p className="text-sm font-medium text-blue-300">Ökosystem nicht unterstützt</p>
      <p className="text-xs text-gray-400 mt-1">
        Dieses Repository verwendet <span className="text-gray-200 font-medium">{label}</span>.
        Lizenz- und Dependency-Scans werden aktuell nur für <span className="text-gray-200 font-medium">Node.js / npm</span> unterstützt.
      </p>
    </div>
  );
}
