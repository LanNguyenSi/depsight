// Route-level tests for GET + POST /api/deps.
// Covers isDependencyScanCandidate filtering branches with mutation-killing assertions.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  repoFindFirst,
  scanFindMany,
  scanDependenciesMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  repoFindFirst: vi.fn(),
  scanFindMany: vi.fn(),
  scanDependenciesMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findFirst: repoFindFirst },
    scan: { findMany: scanFindMany },
  },
}));

vi.mock('@/lib/deps/scanner', () => ({
  scanDependencies: scanDependenciesMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/deps/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/deps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// POST /api/deps
// ---------------------------------------------------------------------------
describe('POST /api/deps', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    repoFindFirst.mockReset();
    scanDependenciesMock.mockReset();
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

  it('returns 404 when repo not found and asserts full ownership where clause', async () => {
    repoFindFirst.mockResolvedValue(null);
    const res = await POST(makePostRequest({ repoId: 'repo-1' }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repository not found');
    expect(repoFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'user-1', tracked: true },
    });
  });

  it('returns 200 with scan result and verifies scanDependencies call args', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1', fullName: 'owner/repo' });
    scanDependenciesMock.mockResolvedValue({ scanId: 'scan-1', depsCount: 5 });
    const res = await POST(makePostRequest({ repoId: 'repo-1' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { scanId: string; depsCount: number };
    expect(body.scanId).toBe('scan-1');
    expect(body.depsCount).toBe(5);
    expect(scanDependenciesMock).toHaveBeenCalledWith('user-1', 'repo-1', 'gh_tok');
  });

  it('returns 500 with error message when scanDependencies throws', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    scanDependenciesMock.mockRejectedValue(new Error('scan exploded'));
    const res = await POST(makePostRequest({ repoId: 'repo-1' }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('scan exploded');
  });
});

// ---------------------------------------------------------------------------
// GET /api/deps — isDependencyScanCandidate filtering logic
// ---------------------------------------------------------------------------
describe('GET /api/deps', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    scanFindMany.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/deps?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when repoId is missing', async () => {
    const req = new NextRequest('http://localhost/api/deps');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
  });

  it('returns 200 empty when findMany returns no scans and verifies query where clause', async () => {
    scanFindMany.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/deps?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { dependencies: unknown[]; summary: null };
    expect(body.dependencies).toEqual([]);
    expect(body.summary).toBeNull();
    expect(scanFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        repoId: 'repo-1',
        repo: { userId: 'user-1', tracked: true },
        status: 'COMPLETED',
      }),
    }));
  });

  it('returns 200 empty when scan has cvePayload set and no deps (isDependencyScanCandidate=false)', async () => {
    // deps.length===0, cvePayload non-null → second branch fails → candidate=false → scan=null
    // Kills: mutation of `dependencies.length > 0` to `>= 0`
    scanFindMany.mockResolvedValue([{
      id: 'scan-1',
      scannedAt: new Date(),
      dependencies: [],
      advisories: [],
      licenses: [],
      cvePayload: '{"some":"data"}',
      licensePayload: null,
    }]);
    const req = new NextRequest('http://localhost/api/deps?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { dependencies: unknown[]; summary: null };
    expect(body.dependencies).toEqual([]);
    expect(body.summary).toBeNull();
  });

  it('returns 200 empty when scan has non-empty advisories, no deps, null payloads (isDependencyScanCandidate=false)', async () => {
    // Kills: mutation removing `&& scan.advisories.length === 0`
    scanFindMany.mockResolvedValue([{
      id: 'scan-adv',
      scannedAt: new Date(),
      dependencies: [],
      advisories: [{ id: 'adv-1' }],
      licenses: [],
      cvePayload: null,
      licensePayload: null,
    }]);
    const req = new NextRequest('http://localhost/api/deps?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { dependencies: unknown[]; summary: null };
    expect(body.dependencies).toEqual([]);
    expect(body.summary).toBeNull();
  });

  it('returns 200 full payload when scan has deps (dependencies.length > 0 branch)', async () => {
    const scannedAt = new Date('2026-01-15T00:00:00Z');
    scanFindMany.mockResolvedValue([{
      id: 'scan-2',
      scannedAt,
      dependencies: [{
        id: 'd1',
        name: 'lodash',
        installedVersion: '4.17.20',
        latestVersion: '4.17.21',
        ageInDays: 365,
        status: 'OUTDATED',
        isDeprecated: false,
        updateAvailable: true,
        publishedAt: new Date('2020-01-01T00:00:00Z'),
        latestPublishedAt: new Date('2021-01-01T00:00:00Z'),
      }],
      advisories: [{ id: 'adv-1' }],
      licenses: [],
      cvePayload: '{"c":"v"}',
      licensePayload: null,
    }]);
    const req = new NextRequest('http://localhost/api/deps?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      scanId: string;
      summary: { total: number; outdated: number; upToDate: number; majorBehind: number; deprecated: number; unknown: number };
      dependencies: Array<{ id: string; name: string; status: string; ageInDays: number }>;
    };
    expect(body.scanId).toBe('scan-2');
    expect(body.summary.total).toBe(1);
    expect(body.summary.outdated).toBe(1);
    expect(body.summary.upToDate).toBe(0);
    expect(body.summary.majorBehind).toBe(0);
    expect(body.dependencies).toHaveLength(1);
    expect(body.dependencies[0].id).toBe('d1');
    expect(body.dependencies[0].name).toBe('lodash');
    expect(body.dependencies[0].status).toBe('OUTDATED');
    expect(body.dependencies[0].ageInDays).toBe(365);
  });

  it('includes scan where all fields are null/empty (second-condition all-null branch)', async () => {
    // deps=[], advisories=[], licenses=[], cvePayload=null, licensePayload=null → candidate=true
    // Kills: mutation of `cvePayload === null` to `cvePayload !== null`
    const scannedAt = new Date('2026-01-20T00:00:00Z');
    scanFindMany.mockResolvedValue([{
      id: 'scan-empty',
      scannedAt,
      dependencies: [],
      advisories: [],
      licenses: [],
      cvePayload: null,
      licensePayload: null,
    }]);
    const req = new NextRequest('http://localhost/api/deps?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { scanId: string; summary: { total: number }; dependencies: unknown[] };
    expect(body.scanId).toBe('scan-empty');
    expect(body.summary.total).toBe(0);
    expect(body.dependencies).toEqual([]);
  });
});
