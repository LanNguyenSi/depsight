// Route-level status-code tests for POST /api/scan.
// Mocking @/lib/cve/scanner in this file is intentionally isolated from
// scanner.test.ts because vi.mock is file-scoped: mixing a full mock of
// scanRepository with the real implementation in one file breaks both sets.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { resolveRequestUserMock, scanRepositoryMock } = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  scanRepositoryMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

// Preserve the real ScanAccessError export so route handler instanceof checks work
vi.mock('@/lib/cve/scanner', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cve/scanner')>();
  return {
    ...original, // includes the real ScanAccessError class
    scanRepository: scanRepositoryMock,
  };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/scan/route';
import { NextRequest } from 'next/server';
import { ScanAccessError } from '@/lib/cve/scanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/scan — route status codes', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    scanRepositoryMock.mockReset();
    resolveRequestUserMock.mockResolvedValue({
      id: 'me',
      githubLogin: 'octocat',
      githubToken: 'gh_tok',
    });
  });

  it('returns 404 when scanRepository throws ScanAccessError(404)', async () => {
    scanRepositoryMock.mockRejectedValue(new ScanAccessError(404, 'Repository not found'));

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repository not found');
  });

  it('returns 403 when scanRepository throws ScanAccessError(403)', async () => {
    scanRepositoryMock.mockRejectedValue(new ScanAccessError(403, 'Access denied'));

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Access denied');
  });

  it('returns 500 for a generic scan failure', async () => {
    scanRepositoryMock.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('boom');
  });

  it('returns 200 with alreadyRunning:false on a successful completed scan', async () => {
    scanRepositoryMock.mockResolvedValue({
      scanId: 'scan-1',
      alreadyRunning: false,
      dependabotDisabled: false,
    });

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; alreadyRunning: boolean; scanId: string };
    expect(body.status).toBe('completed');
    expect(body.alreadyRunning).toBe(false);
    expect(body.scanId).toBe('scan-1');
  });

  it('returns 200 with status:running and alreadyRunning:true when scan is already running', async () => {
    scanRepositoryMock.mockResolvedValue({ scanId: 'running-1', alreadyRunning: true });

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; alreadyRunning: boolean; scanId: string };
    expect(body.status).toBe('running');
    expect(body.alreadyRunning).toBe(true);
    expect(body.scanId).toBe('running-1');
  });

  it('returns 401 when user is not authenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(401);
  });

  it('returns 400 when repoId is missing', async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
  });
});
