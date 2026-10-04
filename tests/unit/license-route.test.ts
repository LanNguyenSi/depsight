// Route-level tests for GET + POST /api/license.
// Asserts Prisma.DbNull filter and computed summary shape.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  scanFindFirst,
  scanLicensesMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  scanFindFirst: vi.fn(),
  scanLicensesMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
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
    scan: { findFirst: scanFindFirst },
  },
}));

vi.mock('@/lib/license/scanner', () => ({
  scanLicenses: scanLicensesMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/license/route';
import { NextRequest } from 'next/server';
import { licenseRateLimiter, LICENSE_LIMIT_PER_HOUR } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok', scope: 'WRITE' as const };
const readOnlyUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok', scope: 'READ' as const };

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/license', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// POST /api/license
// ---------------------------------------------------------------------------
describe('POST /api/license', () => {
  beforeEach(() => {
    licenseRateLimiter.reset();
    resolveRequestUserMock.mockReset();
    scanLicensesMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const res = await POST(makePostRequest({ repoId: 'repo-1' }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when repoId is missing', async () => {
    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
  });

  it('returns 403 when the token has READ scope only (a license scan persists results and spends GitHub quota)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('This token does not have write access');
    expect(scanLicensesMock).not.toHaveBeenCalled();
  });

  it('returns 200 for a WRITE-scoped token', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    scanLicensesMock.mockResolvedValue({ scanId: 'scan-write', licenseCount: 0 });

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
  });

  it('returns 200 with result and verifies scanLicenses call args', async () => {
    scanLicensesMock.mockResolvedValue({ scanId: 'scan-1', licenseCount: 3 });
    const res = await POST(makePostRequest({ repoId: 'repo-1' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { scanId: string; licenseCount: number };
    expect(body.scanId).toBe('scan-1');
    expect(body.licenseCount).toBe(3);
    expect(scanLicensesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'gh_tok');
  });

  it('returns 500 with error message when scanLicenses throws', async () => {
    scanLicensesMock.mockRejectedValue(new Error('license scan failed'));
    const res = await POST(makePostRequest({ repoId: 'repo-1' }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('license scan failed');
  });
});

// ---------------------------------------------------------------------------
// GET /api/license
// ---------------------------------------------------------------------------
describe('GET /api/license', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    scanFindFirst.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/license?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when repoId is missing', async () => {
    const req = new NextRequest('http://localhost/api/license');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
  });

  it('returns 200 for a READ-scoped token (GET is unaffected by scope)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);
    scanFindFirst.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/license?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('returns 200 empty payload when no license scan found and verifies Prisma.DbNull filter', async () => {
    scanFindFirst.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/license?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { licenses: unknown[]; summary: Record<string, unknown>; conflictCount: number };
    expect(body.licenses).toEqual([]);
    expect(body.summary).toEqual({});
    expect(body.conflictCount).toBe(0);
    expect(scanFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        repoId: 'repo-1',
        repo: { userId: 'user-1', tracked: true },
        status: 'COMPLETED',
        licensePayload: { not: Prisma.DbNull },
      }),
    }));
  });

  it('returns 200 full payload with computed summary (MIT:2, GPL:1) and correct conflictCount', async () => {
    const scannedAt = new Date('2026-01-15T00:00:00Z');
    scanFindFirst.mockResolvedValue({
      id: 'scan-1',
      scannedAt,
      licenseCount: 3,
      licenseIssues: 1,
      licenses: [
        { id: 'l1', packageName: 'lodash', version: '4.17.21', license: 'MIT', isCompatible: true, policyViolation: false },
        { id: 'l2', packageName: 'react', version: '18.2.0', license: 'MIT', isCompatible: true, policyViolation: false },
        { id: 'l3', packageName: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0', isCompatible: false, policyViolation: true },
      ],
    });
    const req = new NextRequest('http://localhost/api/license?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      scanId: string;
      licenseCount: number;
      conflictCount: number;
      summary: Record<string, number>;
      licenses: Array<{ id: string; packageName: string; license: string; isCompatible: boolean; policyViolation: boolean }>;
    };
    expect(body.scanId).toBe('scan-1');
    expect(body.licenseCount).toBe(3);
    // conflictCount maps to licenseIssues from the scan row
    expect(body.conflictCount).toBe(1);
    // summary is computed from the licenses array: count by license name
    expect(body.summary).toEqual({ MIT: 2, 'GPL-3.0': 1 });
    expect(body.licenses).toHaveLength(3);
    expect(body.licenses[0].id).toBe('l1');
    expect(body.licenses[0].packageName).toBe('lodash');
    expect(body.licenses[2].license).toBe('GPL-3.0');
    expect(body.licenses[2].policyViolation).toBe(true);
    expect(body.licenses[2].isCompatible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/license: per-user rate limit
// ---------------------------------------------------------------------------
describe('POST /api/license: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    licenseRateLimiter.reset();
    resolveRequestUserMock.mockReset();
    scanLicensesMock.mockReset();
    scanLicensesMock.mockResolvedValue({ scanId: 'scan-1', licenseCount: 0 });
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 429 with Retry-After once the user is over the limit, without scanning', async () => {
    for (let i = 0; i < LICENSE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ repoId: 'repo-1' }))).status).toBe(200);
    }
    expect(scanLicensesMock).toHaveBeenCalledTimes(LICENSE_LIMIT_PER_HOUR);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.retryAfterSeconds).toBe(WINDOW_MS / 1000);
    expect(scanLicensesMock).toHaveBeenCalledTimes(LICENSE_LIMIT_PER_HOUR);
  });

  it('limits per user and allows requests again after the window has elapsed', async () => {
    for (let i = 0; i < LICENSE_LIMIT_PER_HOUR; i++) {
      await POST(makePostRequest({ repoId: 'repo-1' }));
    }
    expect((await POST(makePostRequest({ repoId: 'repo-1' }))).status).toBe(429);

    resolveRequestUserMock.mockResolvedValue({ ...mockUser, id: 'someone-else' });
    expect((await POST(makePostRequest({ repoId: 'repo-1' }))).status).toBe(200);

    resolveRequestUserMock.mockResolvedValue(mockUser);
    vi.advanceTimersByTime(WINDOW_MS);
    expect((await POST(makePostRequest({ repoId: 'repo-1' }))).status).toBe(200);
  });

  it('does not count a request that fails authentication or the write-scope check', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    for (let i = 0; i < LICENSE_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest({ repoId: 'repo-1' }))).status).toBe(401);
    }
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);
    for (let i = 0; i < LICENSE_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest({ repoId: 'repo-1' }))).status).toBe(403);
    }
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
  });
});
