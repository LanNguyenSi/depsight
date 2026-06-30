// Route-level tests for POST /api/export.
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import route last.
// Covers: 401, 400, 409 (no-run), 409 (auto-run but still missing), 200 zip, 500.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  authMock,
  loadRepoExportDataMock,
  getMissingExportScansMock,
  buildRepoExportArchiveMock,
  scanRepositoryMock,
  scanLicensesMock,
  scanDependenciesMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
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
    authMock.mockReset();
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
    authMock.mockResolvedValue({ user: { id: 'user-1', githubToken: 'tok-abc' } });
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
    authMock.mockResolvedValue({ user: { id: 'user-5', githubToken: 'tok-xyz' } });
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
