// Route-level status-code tests for POST /api/scan.
// Mocking @/lib/cve/scanner in this file is intentionally isolated from
// scanner.test.ts because vi.mock is file-scoped: mixing a full mock of
// scanRepository with the real implementation in one file breaks both sets.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { resolveRequestUserMock, scanRepositoryMock, scanFindFirst } = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  scanRepositoryMock: vi.fn(),
  scanFindFirst: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// hasWriteScope is the real implementation here (see auth-api.test.ts for
// its own unit tests), pulled in via vi.importActual so a regression in the
// actual predicate is caught by this route's tests too.
vi.mock('@/lib/auth-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-api')>('@/lib/auth-api');
  return {
    resolveRequestUser: resolveRequestUserMock,
    hasWriteScope: actual.hasWriteScope,
  };
});

// Stubs so the real @/lib/auth-api module (loaded above via importActual,
// purely to get its real hasWriteScope) can load without crashing: its own
// top-level import of ./auth pulls in next-auth, which needs next/headers.
// hasWriteScope itself never touches either, so the stub value is never
// exercised.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    scan: {
      findFirst: scanFindFirst,
    },
  },
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
import { POST, GET } from '@/app/api/scan/route';
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
      scope: 'WRITE',
    });
  });

  it('returns 403 when the token has READ scope only (a scan persists results and spends GitHub quota)', async () => {
    resolveRequestUserMock.mockResolvedValue({
      id: 'me',
      githubLogin: 'octocat',
      githubToken: 'gh_tok',
      scope: 'READ',
    });

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('This token does not have write access');
    expect(scanRepositoryMock).not.toHaveBeenCalled();
  });

  it('returns 200 for a WRITE-scoped token', async () => {
    resolveRequestUserMock.mockResolvedValue({
      id: 'me',
      githubLogin: 'octocat',
      githubToken: 'gh_tok',
      scope: 'WRITE',
    });
    scanRepositoryMock.mockResolvedValue({ scanId: 'scan-write', alreadyRunning: false });

    const res = await POST(makeRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    expect(scanRepositoryMock).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Tests — GET /api/scan
// ---------------------------------------------------------------------------
describe('GET /api/scan — route status codes', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    scanRepositoryMock.mockReset();
    scanFindFirst.mockReset();
    resolveRequestUserMock.mockResolvedValue({
      id: 'me',
      githubLogin: 'octocat',
      githubToken: 'gh_tok',
      scope: 'WRITE',
    });
  });

  it('returns 200 for a READ-scoped token (GET is unaffected by scope)', async () => {
    resolveRequestUserMock.mockResolvedValue({
      id: 'me',
      githubLogin: 'octocat',
      githubToken: 'gh_tok',
      scope: 'READ',
    });
    scanFindFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/scan?repoId=repo-1');
    const res = await GET(req);

    expect(res.status).toBe(200);
  });

  it('returns 401 when user is not authenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/scan?repoId=repo-1');
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when repoId query param is missing', async () => {
    const req = new NextRequest('http://localhost/api/scan');
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
  });

  it('returns 200 with scan:null when no completed scan exists for the repo', async () => {
    scanFindFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/scan?repoId=repo-1');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json() as { scan: null };
    expect(body.scan).toBeNull();
    expect(scanFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ repoId: 'repo-1' }),
      }),
    );
  });

  it('returns 200 with mapped scan and advisories when a completed scan exists', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const pubAt = new Date('2025-06-01T00:00:00Z');
    const mockScan = {
      id: 'scan-1',
      scannedAt: now,
      status: 'COMPLETED',
      riskScore: 7.5,
      cveCount: 1,
      criticalCount: 1,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      advisories: [
        {
          id: 'adv-1',
          ghsaId: 'GHSA-xxxx-yyyy-zzzz',
          cveId: 'CVE-2025-0001',
          source: 'dependabot',
          severity: 'CRITICAL',
          summary: 'A critical issue',
          packageName: 'lodash',
          ecosystem: 'npm',
          vulnerableRange: '< 4.17.21',
          fixedVersion: '4.17.21',
          publishedAt: pubAt,
          url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
        },
        {
          id: 'adv-2',
          ghsaId: 'PYSEC-2025-0002',
          cveId: null,
          source: 'osv',
          severity: 'HIGH',
          summary: 'An OSV-sourced issue',
          packageName: 'requests',
          ecosystem: 'pip',
          vulnerableRange: null,
          fixedVersion: null,
          publishedAt: null,
          url: null,
        },
      ],
    };
    scanFindFirst.mockResolvedValue(mockScan);

    const req = new NextRequest('http://localhost/api/scan?repoId=repo-1');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      scan: {
        id: string;
        status: string;
        riskScore: number;
        counts: { total: number; critical: number };
        advisories: Array<{ id: string; severity: string; source: string }>;
      };
    };
    expect(body.scan).not.toBeNull();
    expect(body.scan.id).toBe('scan-1');
    expect(body.scan.status).toBe('COMPLETED');
    expect(body.scan.riskScore).toBe(7.5);
    expect(body.scan.counts.total).toBe(1);
    expect(body.scan.counts.critical).toBe(1);
    expect(body.scan.advisories).toHaveLength(2);
    expect(body.scan.advisories[0].id).toBe('adv-1');
    expect(body.scan.advisories[0].severity).toBe('CRITICAL');
    // Advisory.source (PR #76) must be serialized so the AdvisoryList UI and
    // the depsight MCP (which passes this response through unchanged) can
    // surface where each CVE came from.
    expect(body.scan.advisories[0].source).toBe('dependabot');
    expect(body.scan.advisories[1].source).toBe('osv');
  });
});
