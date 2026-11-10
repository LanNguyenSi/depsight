// Route-level tests for POST /api/export.
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import route last.
// Covers: 401, 400, 409 (no-run), 409 (auto-run but still missing), 200 zip, 500.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  authMock,
  getTokenMock,
  loadRepoExportDataMock,
  getMissingExportScansMock,
  buildRepoExportArchiveMock,
  scanRepositoryMock,
  scanLicensesMock,
  scanDependenciesMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  getTokenMock: vi.fn(),
  loadRepoExportDataMock: vi.fn(),
  getMissingExportScansMock: vi.fn(),
  buildRepoExportArchiveMock: vi.fn(),
  scanRepositoryMock: vi.fn(),
  scanLicensesMock: vi.fn(),
  scanDependenciesMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/auth-api', () => ({ getSessionGitHubToken: getTokenMock }));
vi.mock('@/lib/export/repo-bundle', () => ({
  loadRepoExportData: loadRepoExportDataMock,
  getMissingExportScans: getMissingExportScansMock,
  buildRepoExportArchive: buildRepoExportArchiveMock,
}));
vi.mock('@/lib/cve/scanner', () => ({ scanRepository: scanRepositoryMock }));
vi.mock('@/lib/license/scanner', () => ({ scanLicenses: scanLicensesMock }));
vi.mock('@/lib/deps/scanner', () => ({ scanDependencies: scanDependenciesMock }));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/export/route';
import {
  scanRateLimiter,
  licenseRateLimiter,
  depsRateLimiter,
  SCAN_LIMIT_PER_HOUR,
  LICENSE_LIMIT_PER_HOUR,
  DEPS_LIMIT_PER_HOUR,
} from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Minimal RepoExportData shape the route actually reads.
const fakeExportData = {
  repo: {
    id: 'repo-1',
    fullName: 'owner/repo',
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    language: null,
    lastScannedAt: null,
  },
  cveScan: { id: 'cve-scan-1' },
  licenseScan: { id: 'lic-scan-1' },
  depsScan: { id: 'dep-scan-1' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/export', () => {
  beforeEach(() => {
    scanRateLimiter.reset();
    licenseRateLimiter.reset();
    depsRateLimiter.reset();
    authMock.mockReset();
    // The session carries no GitHub token; the route reads it server side by user id.
    getTokenMock.mockReset();
    getTokenMock.mockImplementation(async (userId: string) => ({ 'user-1': 'tok-abc', 'user-5': 'tok-xyz' } as Record<string, string>)[userId] ?? '');
    loadRepoExportDataMock.mockReset();
    getMissingExportScansMock.mockReset();
    buildRepoExportArchiveMock.mockReset();
    scanRepositoryMock.mockReset();
    scanLicensesMock.mockReset();
    scanDependenciesMock.mockReset();
  });

  it('(1) returns 401 when auth returns no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(loadRepoExportDataMock).not.toHaveBeenCalled();
  });

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: {} });

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(loadRepoExportDataMock).not.toHaveBeenCalled();
    expect(scanRepositoryMock).not.toHaveBeenCalled();
    expect(scanLicensesMock).not.toHaveBeenCalled();
    expect(scanDependenciesMock).not.toHaveBeenCalled();
    expect(buildRepoExportArchiveMock).not.toHaveBeenCalled();
  });

  it('(2) returns 400 when repoId is missing from the request body', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
    expect(loadRepoExportDataMock).not.toHaveBeenCalled();
  });

  it('(3) returns 409 {error:missing_scans, missingScans} when scans are missing and runMissingScans is false', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValue(['cve', 'license']);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; missingScans: string[] };
    expect(body.error).toBe('missing_scans');
    expect(body.missingScans).toEqual(['cve', 'license']);
    // Scanners must not have been invoked
    expect(scanRepositoryMock).not.toHaveBeenCalled();
    expect(scanLicensesMock).not.toHaveBeenCalled();
    expect(scanDependenciesMock).not.toHaveBeenCalled();
  });

  it('(4) returns 409 with message when scans still missing after auto-run (runMissingScans=true)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    // First getMissingExportScans call triggers auto-run; second call still missing
    getMissingExportScansMock
      .mockReturnValueOnce(['cve', 'deps']) // triggers auto-run
      .mockReturnValue(['cve', 'deps']);    // still missing after auto-run
    scanRepositoryMock.mockResolvedValue({ scanId: 'scan-cve-new' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'scan-deps-new' });

    const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; missingScans: string[]; message: string };
    expect(body.error).toBe('missing_scans');
    expect(body.missingScans).toEqual(['cve', 'deps']);
    expect(body.message).toBe('Not all scans could be prepared for export.');

    // Verify scanners were called with exact args (userId, repoId, githubToken)
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-1', 'tok-abc');
    expect(scanDependenciesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'tok-abc');
    // license scan not in the missing list, so must not be called
    expect(scanLicensesMock).not.toHaveBeenCalled();

    // loadRepoExportData called twice: initial load + reload after scan
    expect(loadRepoExportDataMock).toHaveBeenCalledTimes(2);
    // Second call passes overrides with the new scan IDs
    expect(loadRepoExportDataMock).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'repo-1',
      expect.objectContaining({ cveScanId: 'scan-cve-new', depsScanId: 'scan-deps-new' }),
    );
  });

  it('(4b) returns a clear 409 scan_in_progress signal (not the generic missing_scans one) when the cve scan is already running, without reloading export data', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValueOnce(['cve']); // triggers auto-run
    scanRepositoryMock.mockResolvedValue({ scanId: 'scan-cve-running', alreadyRunning: true });

    const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(res.status).toBe(409);
    const responseBody = await res.json() as { error: string; inProgressScans: string[]; message: string };
    expect(responseBody.error).toBe('scan_in_progress');
    expect(responseBody.inProgressScans).toEqual(['cve']);
    expect(responseBody.message).toBe('A scan is already in progress for this repository; retry shortly.');

    // Must not proceed to license/deps scans, nor reload export data, nor
    // fall through to the generic "missing_scans" 409.
    expect(scanLicensesMock).not.toHaveBeenCalled();
    expect(scanDependenciesMock).not.toHaveBeenCalled();
    expect(loadRepoExportDataMock).toHaveBeenCalledTimes(1);
  });

  it('(5) returns 200 with application/zip content-type and archive bytes when all scans present', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValue([]);
    // Fake ZIP magic bytes (PK header)
    const archiveBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    buildRepoExportArchiveMock.mockReturnValue(archiveBytes);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    // fullName 'owner/repo' → slashes replaced → 'owner-repo-scan-export.zip'
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="owner-repo-scan-export.zip"');
    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    expect(bodyBytes).toEqual(archiveBytes);
    expect(buildRepoExportArchiveMock).toHaveBeenCalledWith(fakeExportData);
    // Primary ownership boundary: the initial load MUST be scoped to the caller.
    // Substituting session.user.id with a constant here must fail this test.
    expect(loadRepoExportDataMock).toHaveBeenNthCalledWith(1, 'user-1', 'repo-1');
    // No scanners triggered when no missing scans
    expect(scanRepositoryMock).not.toHaveBeenCalled();
  });

  it('(6) returns 500 when loadRepoExportData throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockRejectedValue(new Error('Repository not found or access denied'));

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repository not found or access denied');
  });

  it('(7) returns 500 when buildRepoExportArchive throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValue([]);
    buildRepoExportArchiveMock.mockImplementation(() => {
      throw new Error('zip build error');
    });

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('zip build error');
  });

  it('(8) invokes all three scanners when all scan types are missing on auto-run', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-5' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock
      .mockReturnValueOnce(['cve', 'license', 'deps']) // initial — all missing
      .mockReturnValue([]);                             // after auto-run — all present
    scanRepositoryMock.mockResolvedValue({ scanId: 'cve-new' });
    scanLicensesMock.mockResolvedValue({ scanId: 'lic-new' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'dep-new' });
    buildRepoExportArchiveMock.mockReturnValue(new Uint8Array([0x50, 0x4b]));

    const res = await POST(makePostRequest({ repoId: 'repo-5', runMissingScans: true }));

    expect(res.status).toBe(200);
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-5', 'repo-5', 'tok-xyz');
    expect(scanLicensesMock).toHaveBeenCalledWith('user-5', 'repo-5', 'tok-xyz');
    expect(scanDependenciesMock).toHaveBeenCalledWith('user-5', 'repo-5', 'tok-xyz');
    expect(loadRepoExportDataMock).toHaveBeenCalledTimes(2);
    expect(loadRepoExportDataMock).toHaveBeenNthCalledWith(
      2,
      'user-5',
      'repo-5',
      { cveScanId: 'cve-new', licenseScanId: 'lic-new', depsScanId: 'dep-new' },
    );
  });
});

// ---------------------------------------------------------------------------
// The GitHub token is read server side, never from the session
// ---------------------------------------------------------------------------
describe('POST /api/export: GitHub token source', () => {
  beforeEach(() => {
    scanRateLimiter.reset();
    licenseRateLimiter.reset();
    depsRateLimiter.reset();
    authMock.mockReset();
    getTokenMock.mockReset();
    loadRepoExportDataMock.mockReset();
    getMissingExportScansMock.mockReset();
    scanRepositoryMock.mockReset();
    scanLicensesMock.mockReset();
    scanDependenciesMock.mockReset();
    buildRepoExportArchiveMock.mockReset();
  });

  it('looks the token up by the session user id and ignores a token field on the session', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', githubToken: 'from-session' } });
    getTokenMock.mockResolvedValue('from-db');
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValueOnce(['cve', 'license', 'deps']).mockReturnValue([]);
    scanRepositoryMock.mockResolvedValue({ scanId: 'c' });
    scanLicensesMock.mockResolvedValue({ scanId: 'l' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'd' });
    buildRepoExportArchiveMock.mockReturnValue(new Uint8Array([0x50, 0x4b]));

    const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(res.status).toBe(200);
    expect(getTokenMock).toHaveBeenCalledWith('user-1');
    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-1', 'from-db');
    expect(scanLicensesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'from-db');
    expect(scanDependenciesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'from-db');
  });

  it('passes an empty token on as it is for a user without a stored token (same call as before)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    getTokenMock.mockResolvedValue('');
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValueOnce(['cve']).mockReturnValue([]);
    scanRepositoryMock.mockResolvedValue({ scanId: 'c' });
    buildRepoExportArchiveMock.mockReturnValue(new Uint8Array([0x50, 0x4b]));

    await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(scanRepositoryMock).toHaveBeenCalledWith('user-1', 'repo-1', '');
  });

  it('does not read the token for an export that runs no scan', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    getMissingExportScansMock.mockReturnValue([]);
    buildRepoExportArchiveMock.mockReturnValue(new Uint8Array([0x50, 0x4b]));

    const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(res.status).toBe(200);
    expect(getTokenMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-user rate limits: only for the scans an export actually starts
// ---------------------------------------------------------------------------
describe('POST /api/export: scan rate limits', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  function exhaust(limiter: { check: (k: string) => unknown }, limit: number, user = 'user-1') {
    for (let i = 0; i < limit; i++) limiter.check(user);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    scanRateLimiter.reset();
    licenseRateLimiter.reset();
    depsRateLimiter.reset();
    authMock.mockReset();
    getTokenMock.mockReset();
    getTokenMock.mockResolvedValue('tok-abc');
    loadRepoExportDataMock.mockReset();
    getMissingExportScansMock.mockReset();
    scanRepositoryMock.mockReset();
    scanLicensesMock.mockReset();
    scanDependenciesMock.mockReset();
    buildRepoExportArchiveMock.mockReset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    loadRepoExportDataMock.mockResolvedValue(fakeExportData);
    scanRepositoryMock.mockResolvedValue({ scanId: 'c' });
    scanLicensesMock.mockResolvedValue({ scanId: 'l' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'd' });
    buildRepoExportArchiveMock.mockReturnValue(new Uint8Array([0x50, 0x4b]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not limit an export of existing data, even with every scan limiter exhausted', async () => {
    exhaust(scanRateLimiter, SCAN_LIMIT_PER_HOUR);
    exhaust(licenseRateLimiter, LICENSE_LIMIT_PER_HOUR);
    exhaust(depsRateLimiter, DEPS_LIMIT_PER_HOUR);
    getMissingExportScansMock.mockReturnValue([]);

    for (const runMissingScans of [false, true]) {
      const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans }));
      expect(res.status).toBe(200);
    }
    expect(scanRepositoryMock).not.toHaveBeenCalled();
  });

  it('does not count or limit an export that stops at the missing_scans 409 (runMissingScans false)', async () => {
    exhaust(scanRateLimiter, SCAN_LIMIT_PER_HOUR);
    getMissingExportScansMock.mockReturnValue(['cve']);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('missing_scans');
  });

  it.each([
    ['cve', scanRateLimiter, SCAN_LIMIT_PER_HOUR],
    ['license', licenseRateLimiter, LICENSE_LIMIT_PER_HOUR],
    ['deps', depsRateLimiter, DEPS_LIMIT_PER_HOUR],
  ] as const)('answers 429 with Retry-After when the %s limiter is exhausted and that scan is missing, without any scan', async (kind, limiter, limit) => {
    exhaust(limiter, limit);
    getMissingExportScansMock.mockReturnValue([kind]);

    const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(scanRepositoryMock).not.toHaveBeenCalled();
    expect(scanLicensesMock).not.toHaveBeenCalled();
    expect(scanDependenciesMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('is not limited by the limiter of a scan that is not missing', async () => {
    exhaust(scanRateLimiter, SCAN_LIMIT_PER_HOUR);
    exhaust(depsRateLimiter, DEPS_LIMIT_PER_HOUR);
    getMissingExportScansMock.mockReturnValueOnce(['license']).mockReturnValue([]);

    const res = await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }));

    expect(res.status).toBe(200);
    expect(scanLicensesMock).toHaveBeenCalledTimes(1);
  });

  it('counts one request per missing scan against that limiter, per user', async () => {
    // Every export finds the cve scan missing first and complete after running it.
    const missingThenComplete = () => {
      let call = 0;
      getMissingExportScansMock.mockReset();
      getMissingExportScansMock.mockImplementation(() => (call++ % 2 === 0 ? ['cve'] : []));
    };
    for (let i = 0; i < SCAN_LIMIT_PER_HOUR; i++) {
      missingThenComplete();
      expect((await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }))).status).toBe(200);
    }
    expect(scanRepositoryMock).toHaveBeenCalledTimes(SCAN_LIMIT_PER_HOUR);
    missingThenComplete();
    expect((await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }))).status).toBe(429);
    expect(scanRepositoryMock).toHaveBeenCalledTimes(SCAN_LIMIT_PER_HOUR);

    authMock.mockResolvedValue({ user: { id: 'someone-else' } });
    missingThenComplete();
    expect((await POST(makePostRequest({ repoId: 'repo-1', runMissingScans: true }))).status).toBe(200);
    expect(scanRepositoryMock).toHaveBeenCalledTimes(SCAN_LIMIT_PER_HOUR + 1);
  });
});
