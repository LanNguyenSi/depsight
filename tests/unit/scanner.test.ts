import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist all mock handles so vi.mock factories can reference them
// ---------------------------------------------------------------------------
const {
  repoFindUnique,
  scanFindFirst,
  scanCreate,
  scanUpdate,
  repoUpdate,
  advisoryCreateMany,
  advisoryFindMany,
  txMock,
} = vi.hoisted(() => {
  const txMock = vi.fn();
  return {
    repoFindUnique: vi.fn(),
    scanFindFirst: vi.fn(),
    scanCreate: vi.fn(),
    scanUpdate: vi.fn(),
    repoUpdate: vi.fn(),
    advisoryCreateMany: vi.fn(),
    advisoryFindMany: vi.fn(),
    txMock,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findUnique: repoFindUnique,
      update: repoUpdate,
    },
    scan: {
      findFirst: scanFindFirst,
      create: scanCreate,
      update: scanUpdate,
    },
    advisory: {
      createMany: advisoryCreateMany,
      findMany: advisoryFindMany,
    },
    $transaction: txMock,
  },
}));

vi.mock('@/lib/cve/github-advisories', () => ({
  fetchRepoAdvisories: vi.fn().mockResolvedValue({
    advisories: [],
    dependabotDisabled: false,
  }),
  buildScanResult: vi.fn().mockReturnValue({
    advisories: [],
    counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    riskScore: 0,
    dependabotDisabled: false,
  }),
}));

vi.mock('@/lib/cve/osv', () => ({
  fetchOsvAdvisories: vi.fn().mockResolvedValue({ advisories: [], ecosystem: 'npm' }),
}));

vi.mock('@/lib/cve/merge', () => ({
  mergeCveAdvisories: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/alerts/notifier', () => ({
  notifyForScan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/alerts/post-scan', () => ({
  runPostScanHooks: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks are in place
// ---------------------------------------------------------------------------
import { scanRepository, ScanAccessError } from '@/lib/cve/scanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VALID_REPO = {
  id: 'repo-1',
  userId: 'me',
  tracked: true,
  owner: 'acme',
  name: 'web',
  fullName: 'acme/web',
  defaultBranch: 'main',
};

// ---------------------------------------------------------------------------
// Scanner unit tests
// ---------------------------------------------------------------------------
describe('scanRepository — access control', () => {
  beforeEach(() => {
    repoFindUnique.mockReset();
    scanFindFirst.mockReset();
    scanCreate.mockReset();
    scanUpdate.mockReset();
    repoUpdate.mockReset();
    advisoryCreateMany.mockReset();
    advisoryFindMany.mockReset();
    txMock.mockReset();
  });

  // Case 1: unknown repo
  it('throws ScanAccessError(404) when the repo does not exist', async () => {
    repoFindUnique.mockResolvedValue(null);

    const err = await scanRepository('me', 'repo-1', 'tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScanAccessError);
    expect((err as ScanAccessError).status).toBe(404);
    expect((err as ScanAccessError).message).toBe('Repository not found');
    expect(scanCreate).not.toHaveBeenCalled();
  });

  // Case 2: repo exists but not owned
  it('throws ScanAccessError(403) when the repo is not owned by the user', async () => {
    repoFindUnique.mockResolvedValue({ ...VALID_REPO, userId: 'someone-else' });

    const err = await scanRepository('me', 'repo-1', 'tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScanAccessError);
    expect((err as ScanAccessError).status).toBe(403);
    expect((err as ScanAccessError).message).toBe('Access denied');
    expect(scanCreate).not.toHaveBeenCalled();
  });

  // Case 3: owned but untracked
  it('throws ScanAccessError(404) when the repo is not tracked', async () => {
    repoFindUnique.mockResolvedValue({ ...VALID_REPO, tracked: false });

    const err = await scanRepository('me', 'repo-1', 'tok').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScanAccessError);
    expect((err as ScanAccessError).status).toBe(404);
    expect((err as ScanAccessError).message).toBe('Repository is not tracked');
    expect(scanCreate).not.toHaveBeenCalled();
  });

  // Case 4: already-running guard (must-block case)
  it('returns alreadyRunning:true and does NOT call scan.create when a RUNNING scan exists', async () => {
    repoFindUnique.mockResolvedValue(VALID_REPO);
    scanFindFirst.mockResolvedValue({ id: 'running-1', status: 'RUNNING' });

    const result = await scanRepository('me', 'repo-1', 'tok');

    expect(result).toEqual({ scanId: 'running-1', alreadyRunning: true });
    expect(scanCreate).not.toHaveBeenCalled();
    // Pin the guard query shape so a mutation that drops the status filter or the
    // time-window predicate (or matches COMPLETED/FAILED) is caught.
    expect(scanFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repoId: 'repo-1',
          status: 'RUNNING',
          scannedAt: { gte: expect.any(Date) },
        }),
      }),
    );
  });

  // Case 5: NEGATIVE CONTROL — no running scan → scan.create IS called
  it('(negative control) calls scan.create and returns alreadyRunning:false when no RUNNING scan exists', async () => {
    repoFindUnique.mockResolvedValue(VALID_REPO);
    scanFindFirst.mockResolvedValue(null); // no running scan
    scanCreate.mockResolvedValue({ id: 'scan-1' });
    advisoryFindMany.mockResolvedValue([]);

    // $transaction: invoke the callback with stubbed tx methods
    txMock.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({
        advisory: { createMany: advisoryCreateMany },
        scan: { update: scanUpdate },
        repo: { update: repoUpdate },
      });
    });
    scanUpdate.mockResolvedValue({});
    repoUpdate.mockResolvedValue({});

    const result = await scanRepository('me', 'repo-1', 'tok');

    expect(scanCreate).toHaveBeenCalledTimes(1);
    expect(result.scanId).toBe('scan-1');
    expect(result.alreadyRunning).toBeFalsy();
  });
});
