// Per-scanner freshness: drives the REAL cron + the three REAL scanners against
// an in-memory Repo row, with only the network-facing detectors mocked. A
// scanner that throws must leave its own success timestamp alone and show a
// failure marker while the others advance; the cron must never stamp a success
// timestamp itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanRepository } from '@/lib/cve/scanner';
import { scanDependencies } from '@/lib/deps/scanner';
import {
  failingScanners,
  getScannerStatuses,
  scanFailureData,
  scanSuccessData,
} from '@/lib/scan/freshness';

const { store, detectors, faults } = vi.hoisted(() => {
  const store = {
    repo: {} as Record<string, unknown>,
    scans: [] as Array<Record<string, unknown>>,
    nextScanId: 1,
  };
  const detectors = {
    osv: vi.fn(),
    licenses: vi.fn(),
    depAge: vi.fn(),
  };
  // Faults the prisma mock injects on demand; reset before every test.
  const faults = {
    transaction: null as Error | null,
    depsCreateMany: null as Error | null,
    failMarkerWrite: false,
  };
  return { store, detectors, faults };
});

vi.mock('@/lib/prisma', () => {
  const repoApi = {
    findMany: vi.fn(async () => [{ id: 'repo-1', fullName: 'acme/repo-1' }]),
    findUnique: vi.fn(async () => store.repo),
    findFirst: vi.fn(async () => store.repo),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      // Simulates the failure-marker write itself failing (any *ScanError set).
      if (faults.failMarkerWrite && Object.entries(data).some(([k, v]) => k.endsWith('ScanError') && v !== null)) {
        throw new Error('marker write failed');
      }
      Object.assign(store.repo, data);
      return store.repo;
    }),
  };
  const scanApi = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const scan = { id: `scan-${store.nextScanId++}`, ...data };
      store.scans.push(scan);
      return scan;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const scan = store.scans.find((s) => s.id === where.id)!;
      Object.assign(scan, data);
      return scan;
    }),
  };
  const tx = {
    repo: repoApi,
    scan: scanApi,
    advisory: { createMany: vi.fn(async () => ({})) },
    licenseResult: { createMany: vi.fn(async () => ({})) },
    dependency: {
      createMany: vi.fn(async () => {
        if (faults.depsCreateMany) throw faults.depsCreateMany;
        return {};
      }),
    },
  };
  return {
    prisma: {
      user: {
        findMany: vi.fn(async () => [{ id: 'user-1', githubLogin: 'acme', githubToken: 'tok' }]),
      },
      repo: repoApi,
      scan: scanApi,
      advisory: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => {
        if (faults.transaction) throw faults.transaction;
        return cb(tx);
      }),
    },
  };
});

vi.mock('@/lib/github', () => ({ getUserRepos: vi.fn(async () => []) }));
vi.mock('@/lib/repos/sync', () => ({ syncUserRepos: vi.fn(async () => ({ syncedCount: 0 })) }));
vi.mock('@/lib/ci/sync', () => ({
  syncAllUserRepos: vi.fn(async () => ({ reposSucceeded: 0, totalRunsIngested: 0 })),
}));
vi.mock('@/lib/cve/github-advisories', () => ({
  fetchRepoAdvisories: vi.fn(async () => ({
    advisories: [],
    counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    riskScore: 0,
    dependabotDisabled: false,
  })),
  buildScanResult: vi.fn(() => ({
    advisories: [],
    counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    riskScore: 0,
  })),
}));
vi.mock('@/lib/cve/osv', () => ({ fetchOsvAdvisories: detectors.osv }));
vi.mock('@/lib/cve/merge', () => ({ mergeCveAdvisories: vi.fn(() => []) }));
vi.mock('@/lib/license/detector', () => ({ detectLicenses: detectors.licenses }));
vi.mock('@/lib/deps/age-checker', () => ({ analyzeDepAge: detectors.depAge }));
vi.mock('@/lib/alerts/notifier', () => ({ notifyForScan: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts/post-scan', () => ({ runPostScanHooks: vi.fn(async () => undefined) }));

const T1 = new Date('2026-07-01T12:00:10.000Z'); // first cycle (10s startup delay after 12:00:00)
const T2 = new Date('2026-07-01T14:00:10.000Z'); // second cycle, two hours later

function succeedAll() {
  detectors.osv.mockResolvedValue({ advisories: [], ecosystem: 'npm' });
  detectors.licenses.mockResolvedValue({ licenses: [], conflictCount: 0 });
  detectors.depAge.mockResolvedValue({ dependencies: [], summary: {} });
}

async function runCycleAt(startIso: string) {
  vi.setSystemTime(new Date(startIso));
  vi.resetModules();
  const { startAutoScan } = await import('@/lib/cron/auto-scan');
  startAutoScan();
  await vi.advanceTimersByTimeAsync(10_000);
  vi.clearAllTimers();
  process.removeAllListeners('SIGTERM');
}

beforeEach(() => {
  store.repo = {
    id: 'repo-1',
    userId: 'user-1',
    tracked: true,
    owner: 'acme',
    name: 'repo-1',
    fullName: 'acme/repo-1',
    defaultBranch: 'main',
    lastScannedAt: null,
    lastScanAttemptAt: null,
    cveScannedAt: null,
    licenseScannedAt: null,
    depsScannedAt: null,
    cveScanError: null,
    licenseScanError: null,
    depsScanError: null,
  };
  store.scans = [];
  store.nextScanId = 1;
  faults.transaction = null;
  faults.depsCreateMany = null;
  faults.failMarkerWrite = false;
  detectors.osv.mockReset();
  detectors.licenses.mockReset();
  detectors.depAge.mockReset();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.removeAllListeners('SIGTERM');
});

describe('cron + scanners: per-scanner freshness', () => {
  it('a scanner that throws on every run keeps its old timestamp and shows a failure while the others advance', async () => {
    succeedAll();
    await runCycleAt('2026-07-01T12:00:00Z');
    expect(store.repo.licenseScannedAt).toEqual(T1);

    // Second cycle: the license scanner throws, the other two succeed.
    succeedAll();
    detectors.licenses.mockRejectedValue(new Error('license backend down'));
    await runCycleAt('2026-07-01T14:00:00Z');

    expect(store.repo.cveScannedAt).toEqual(T2);
    expect(store.repo.depsScannedAt).toEqual(T2);
    expect(store.repo.licenseScannedAt).toEqual(T1); // did not advance
    expect(store.repo.licenseScanError).toBe('license backend down');
    expect(store.repo.cveScanError).toBeNull();
    expect(store.repo.depsScanError).toBeNull();

    const statuses = getScannerStatuses(store.repo as never);
    expect(failingScanners(statuses)).toEqual(['license']);
    expect(statuses.license.lastSuccessAt).toBe(T1.toISOString());
  });

  it('when all three scanners throw, no scanner timestamp advances and lastScannedAt does not move', async () => {
    succeedAll();
    await runCycleAt('2026-07-01T12:00:00Z');

    // The OSV rejection is a synthetic failure shape (the real OSV client never
    // throws); the reachable CVE failure path is covered separately below.
    detectors.osv.mockRejectedValue(new Error('osv down'));
    detectors.licenses.mockRejectedValue(new Error('license down'));
    detectors.depAge.mockRejectedValue(new Error('deps down'));
    await runCycleAt('2026-07-01T14:00:00Z');

    expect(store.repo.cveScannedAt).toEqual(T1);
    expect(store.repo.licenseScannedAt).toEqual(T1);
    expect(store.repo.depsScannedAt).toEqual(T1);
    // The cron must not stamp a success itself after an all-failure attempt.
    expect(store.repo.lastScannedAt).toEqual(T1);
    // The attempt is still recorded, separately, for the cron's due-gate.
    expect(store.repo.lastScanAttemptAt).toEqual(T2);
    expect(failingScanners(getScannerStatuses(store.repo as never))).toEqual(['cve', 'license', 'deps']);
  });

  it('a failure from a scanner that never succeeded is visible even though lastScannedAt stays null', async () => {
    detectors.osv.mockResolvedValue({ advisories: [], ecosystem: 'npm' });
    detectors.licenses.mockResolvedValue({ licenses: [], conflictCount: 0 });
    detectors.depAge.mockRejectedValue(new Error('registry unreachable'));
    await runCycleAt('2026-07-01T12:00:00Z');

    expect(store.repo.depsScannedAt).toBeNull();
    expect(store.repo.depsScanError).toBe('registry unreachable');
  });

  it('a later success clears the failure marker', async () => {
    detectors.osv.mockResolvedValue({ advisories: [], ecosystem: 'npm' });
    detectors.licenses.mockRejectedValue(new Error('license backend down'));
    detectors.depAge.mockResolvedValue({ dependencies: [], summary: {} });
    await runCycleAt('2026-07-01T12:00:00Z');
    expect(store.repo.licenseScanError).toBe('license backend down');

    succeedAll();
    await runCycleAt('2026-07-01T14:00:00Z');
    expect(store.repo.licenseScanError).toBeNull();
    expect(store.repo.licenseScannedAt).toEqual(T2);
  });
});

describe('failure recording on paths production can reach', () => {
  it('a CVE scan whose persistence transaction rejects keeps cveScannedAt and shows a failure', async () => {
    succeedAll();
    vi.setSystemTime(T1);
    await scanRepository('user-1', 'repo-1', 'tok');
    expect(store.repo.cveScannedAt).toEqual(T1);

    vi.setSystemTime(T2);
    faults.transaction = new Error('advisory insert failed');
    await expect(scanRepository('user-1', 'repo-1', 'tok')).rejects.toThrow('advisory insert failed');

    expect(store.repo.cveScannedAt).toEqual(T1); // did not advance
    expect(store.repo.lastScannedAt).toEqual(T1);
    expect(store.repo.cveScanError).toBe('advisory insert failed');
    expect(store.scans[1].status).toBe('FAILED');
  });

  it('a deps write that rejects after the age check succeeded keeps depsScannedAt and shows a failure', async () => {
    succeedAll();
    vi.setSystemTime(T1);
    await scanDependencies('user-1', 'repo-1', 'tok');
    expect(store.repo.depsScannedAt).toEqual(T1);

    // The age check succeeds and returns rows, then the insert of those rows fails.
    detectors.depAge.mockResolvedValue({
      dependencies: [
        {
          name: 'left-pad',
          installedVersion: '1.0.0',
          latestVersion: '1.3.0',
          publishedAt: null,
          ageInDays: 10,
          status: 'CURRENT',
          isDeprecated: false,
          updateAvailable: true,
          latestPublishedAt: null,
        },
      ],
      summary: {},
    });
    faults.depsCreateMany = new Error('dependency insert failed');
    vi.setSystemTime(T2);
    await expect(scanDependencies('user-1', 'repo-1', 'tok')).rejects.toThrow('dependency insert failed');

    expect(store.repo.depsScannedAt).toEqual(T1); // did not advance
    expect(store.repo.depsScanError).toBe('dependency insert failed');
    expect(store.scans[1].status).toBe('FAILED');
  });

  it('when writing the failure marker itself fails, the scanner still rejects with its original error and the scan row is FAILED', async () => {
    succeedAll();
    detectors.depAge.mockResolvedValue({ dependencies: [], summary: {} });
    faults.depsCreateMany = null;
    faults.transaction = new Error('original scan error');
    faults.failMarkerWrite = true;

    await expect(scanDependencies('user-1', 'repo-1', 'tok')).rejects.toThrow('original scan error');

    expect(store.scans).toHaveLength(1);
    expect(store.scans[0].status).toBe('FAILED');
    expect(store.scans[0].error).toBe('original scan error');
    expect(store.repo.depsScanError).toBeNull(); // the marker write did fail
  });
});

describe('freshness helpers', () => {
  it('scanSuccessData advances only its own scanner, lastScannedAt, and clears its error', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    expect(scanSuccessData('cve', now)).toEqual({ lastScannedAt: now, cveScannedAt: now, cveScanError: null });
    expect(scanSuccessData('license', now)).toEqual({ lastScannedAt: now, licenseScannedAt: now, licenseScanError: null });
    expect(scanSuccessData('deps', now)).toEqual({ lastScannedAt: now, depsScannedAt: now, depsScanError: null });
  });

  it('scanFailureData records only the message for its scanner and never a timestamp', () => {
    expect(scanFailureData('cve', new Error('boom'))).toEqual({ cveScanError: 'boom' });
    expect(scanFailureData('license', 'plain string')).toEqual({ licenseScanError: 'plain string' });
    expect(scanFailureData('deps', new Error(''))).toEqual({ depsScanError: 'Scan failed' });
  });

  it('scanFailureData truncates very long messages', () => {
    const data = scanFailureData('cve', new Error('x'.repeat(2000)));
    expect(data.cveScanError).toHaveLength(500);
  });

  it('getScannerStatuses treats missing columns as not failing', () => {
    const statuses = getScannerStatuses({} as never);
    expect(failingScanners(statuses)).toEqual([]);
    expect(statuses.cve).toEqual({ lastSuccessAt: null, error: null });
  });
});
