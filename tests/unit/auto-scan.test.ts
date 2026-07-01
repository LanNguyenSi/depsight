// Unit tests for lib/cron/auto-scan.ts (startAutoScan / the internal runAutoScan cycle).
// PATTERN B: hoisted mock handles, vi.mock() before imports.
//
// runAutoScan itself is not exported — it is invoked by the setTimeout(...,
// 10_000) that startAutoScan schedules on the way in. Each test uses fake
// timers, calls startAutoScan(), then advances 10s to trigger exactly one
// runAutoScan cycle and asserts on the mocked dependencies it drove.
//
// The module keeps mutable singleton state (`timer`, `running`), so each test
// resets the module registry and re-imports to get a clean instance; the
// hoisted vi.fn() mock handles persist across resetModules() since they are
// plain closures, not part of the module registry.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  userFindMany,
  repoFindMany,
  repoUpdate,
  getUserReposMock,
  syncUserReposMock,
  scanRepositoryMock,
  scanLicensesMock,
  scanDependenciesMock,
  syncAllUserReposMock,
} = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  repoFindMany: vi.fn(),
  repoUpdate: vi.fn(),
  getUserReposMock: vi.fn(),
  syncUserReposMock: vi.fn(),
  scanRepositoryMock: vi.fn(),
  scanLicensesMock: vi.fn(),
  scanDependenciesMock: vi.fn(),
  syncAllUserReposMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findMany: userFindMany },
    repo: { findMany: repoFindMany, update: repoUpdate },
  },
}));
vi.mock('@/lib/github', () => ({ getUserRepos: getUserReposMock }));
vi.mock('@/lib/repos/sync', () => ({ syncUserRepos: syncUserReposMock }));
vi.mock('@/lib/cve/scanner', () => ({ scanRepository: scanRepositoryMock }));
vi.mock('@/lib/license/scanner', () => ({ scanLicenses: scanLicensesMock }));
vi.mock('@/lib/deps/scanner', () => ({ scanDependencies: scanDependenciesMock }));
vi.mock('@/lib/ci/sync', () => ({ syncAllUserRepos: syncAllUserReposMock }));

const USER = { id: 'user-1', githubLogin: 'acme', githubToken: 'tok-abc' };

async function loadFreshModule() {
  vi.resetModules();
  const mod = await import('@/lib/cron/auto-scan');
  return mod;
}

beforeEach(() => {
  userFindMany.mockReset();
  repoFindMany.mockReset();
  repoUpdate.mockReset();
  getUserReposMock.mockReset();
  syncUserReposMock.mockReset();
  scanRepositoryMock.mockReset();
  scanLicensesMock.mockReset();
  scanDependenciesMock.mockReset();
  syncAllUserReposMock.mockReset();

  // Defaults: one user, syncs cleanly, CI sync cleanly, no console noise assertions.
  userFindMany.mockResolvedValue([USER]);
  getUserReposMock.mockResolvedValue([]);
  syncUserReposMock.mockResolvedValue({ syncedCount: 0, removedCount: 0 });
  syncAllUserReposMock.mockResolvedValue({ reposSucceeded: 0, totalRunsIngested: 0 });
  repoFindMany.mockResolvedValue([]);
  repoUpdate.mockResolvedValue({});

  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
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

describe('auto-scan — scan selection', () => {
  it('queries repo.findMany scoped by userId + tracked:true + stale (null or older than the interval)', async () => {
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    // Default INTERVAL_MS = 60min (SCAN_INTERVAL_MINUTES unset -> 60).
    expect(repoFindMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        tracked: true,
        OR: [
          { lastScannedAt: null },
          { lastScannedAt: { lt: new Date('2026-07-01T11:00:10.000Z') } },
        ],
      },
      select: { id: true, fullName: true },
    });
  });

  it('skips dependency scans entirely when no repo is stale', async () => {
    repoFindMany.mockResolvedValue([]);
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scanRepositoryMock).not.toHaveBeenCalled();
    expect(scanLicensesMock).not.toHaveBeenCalled();
    expect(scanDependenciesMock).not.toHaveBeenCalled();
  });

  it('scans each stale repo returned by repo.findMany and marks it lastScannedAt on success', async () => {
    repoFindMany.mockResolvedValue([{ id: 'repo-1', fullName: 'acme/repo-1' }]);
    scanRepositoryMock.mockResolvedValue({ scanId: 'cve-1' });
    scanLicensesMock.mockResolvedValue({ scanId: 'lic-1' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'dep-1' });
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-1', 'tok-abc');
    expect(scanLicensesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'tok-abc');
    expect(scanDependenciesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'tok-abc');
    expect(repoUpdate).toHaveBeenCalledWith({
      where: { id: 'repo-1' },
      data: { lastScannedAt: new Date('2026-07-01T12:00:10.000Z') },
    });
  });
});

describe('auto-scan — failure handling: one repo must not abort the others', () => {
  it('a repo whose scans all reject (non-rate-limit) does not stop the next repo from being scanned', async () => {
    // Non-rate-limit scan failures are logged (console.warn) but do not set
    // `rateLimited`, so the loop does not `break` — the next repo is still
    // attempted. (Both repos end up lastScannedAt-stamped: the source only
    // skips that stamp when the batch was rate-limited.)
    repoFindMany.mockResolvedValue([
      { id: 'repo-fail', fullName: 'acme/repo-fail' },
      { id: 'repo-ok', fullName: 'acme/repo-ok' },
    ]);
    scanRepositoryMock
      .mockRejectedValueOnce(new Error('CVE scan exploded'))
      .mockResolvedValueOnce({ scanId: 'cve-2' });
    scanLicensesMock
      .mockRejectedValueOnce(new Error('license scan exploded'))
      .mockResolvedValueOnce({ scanId: 'lic-2' });
    scanDependenciesMock
      .mockRejectedValueOnce(new Error('deps scan exploded'))
      .mockResolvedValueOnce({ scanId: 'dep-2' });
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    // Both repos were attempted — the failure on repo-fail did not stop repo-ok.
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-fail', 'tok-abc');
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-ok', 'tok-abc');
    expect(repoUpdate).toHaveBeenCalledWith({
      where: { id: 'repo-ok' },
      data: { lastScannedAt: new Date('2026-07-01T12:00:10.000Z') },
    });
  });

  it('a rate-limit-flavored rejection stops further repos for that user, but does not throw', async () => {
    repoFindMany.mockResolvedValue([
      { id: 'repo-a', fullName: 'acme/repo-a' },
      { id: 'repo-b', fullName: 'acme/repo-b' },
    ]);
    scanRepositoryMock.mockRejectedValueOnce(new Error('API rate limit exceeded'));
    scanLicensesMock.mockRejectedValueOnce(new Error('API rate limit exceeded'));
    scanDependenciesMock.mockRejectedValueOnce(new Error('API rate limit exceeded'));
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    // repo-a was attempted, repo-b was not (loop broke on rate limit).
    expect(scanRepositoryMock).toHaveBeenCalledTimes(1);
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-a', 'tok-abc');
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  it('a user-level fatal error (getUserRepos throws) is caught and does not abort the whole run', async () => {
    const userB = { id: 'user-2', githubLogin: 'user-b', githubToken: 'tok-b' };
    userFindMany.mockResolvedValue([USER, userB]);
    getUserReposMock
      .mockRejectedValueOnce(new Error('GitHub auth revoked'))
      .mockResolvedValueOnce([]);
    const { startAutoScan } = await loadFreshModule();

    // Should not throw despite the first user's hard failure.
    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getUserReposMock).toHaveBeenCalledTimes(2);
  });

  it('the `running` guard skips an overlapping cycle: an interval-triggered run during a slow in-flight run is a no-op', async () => {
    let resolveUsers!: (v: unknown[]) => void;
    userFindMany.mockReturnValue(new Promise((resolve) => { resolveUsers = resolve; }));
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    // Fire the initial 10s setTimeout -> first runAutoScan() begins and is
    // left in-flight (awaiting the still-pending user.findMany promise).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(userFindMany).toHaveBeenCalledTimes(1);

    // Advance by the full interval (60min default) to fire the setInterval
    // callback while the first cycle is still running. The `running` guard
    // should make this second call a no-op (no second user.findMany call).
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(userFindMany).toHaveBeenCalledTimes(1);

    // Let the first cycle finish so fake timers/mocks don't leak into other tests.
    resolveUsers([]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a generic (non-rate-limit) CI sync failure is logged and dependency scanning still proceeds', async () => {
    repoFindMany.mockResolvedValue([{ id: 'repo-1', fullName: 'acme/repo-1' }]);
    syncAllUserReposMock.mockRejectedValueOnce(new Error('CI database unreachable'));
    scanRepositoryMock.mockResolvedValue({ scanId: 'cve-1' });
    scanLicensesMock.mockResolvedValue({ scanId: 'lic-1' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'dep-1' });
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    // Dep scans still ran despite the CI sync failure (not rate-limit-flavored).
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-1', 'tok-abc');
  });

  it('a rate-limit-flavored CI sync failure skips dependency scans for that user even though repos are stale', async () => {
    repoFindMany.mockResolvedValue([{ id: 'repo-1', fullName: 'acme/repo-1' }]);
    syncAllUserReposMock.mockRejectedValueOnce(new Error('secondary rate limit hit'));
    const { startAutoScan } = await loadFreshModule();

    startAutoScan();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scanRepositoryMock).not.toHaveBeenCalled();
  });
});
