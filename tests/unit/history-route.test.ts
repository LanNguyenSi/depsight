// Route-level tests for GET /api/history.
// Covers ownership assertion, Prisma.DbNull filter, limit cap at 100, and full history shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  repoFindFirst,
  scanFindMany,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  repoFindFirst: vi.fn(),
  scanFindMany: vi.fn(),
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

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/history/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/history', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    repoFindFirst.mockReset();
    scanFindMany.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/history?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when repoId is missing', async () => {
    const req = new NextRequest('http://localhost/api/history');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
  });

  it('returns 404 when repo not found and verifies full ownership where clause incl tracked:true', async () => {
    repoFindFirst.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/history?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repository not found');
    expect(repoFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'user-1', tracked: true },
      select: { id: true, fullName: true },
    });
  });

  it('returns 200 with empty history and verifies Prisma.DbNull filter and default take', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1', fullName: 'owner/repo' });
    scanFindMany.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/history?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { repoId: string; repoName: string; history: unknown[] };
    expect(body.repoId).toBe('repo-1');
    expect(body.repoName).toBe('owner/repo');
    expect(body.history).toEqual([]);
    expect(scanFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        repoId: 'repo-1',
        status: 'COMPLETED',
        cvePayload: { not: Prisma.DbNull },
      },
      take: 30,
    }));
  });

  it('returns 200 with full history entry mapped to exact shape (incl ISO date)', async () => {
    const scannedAt = new Date('2026-01-10T00:00:00Z');
    repoFindFirst.mockResolvedValue({ id: 'repo-1', fullName: 'owner/repo' });
    scanFindMany.mockResolvedValue([{
      id: 'scan-1',
      scannedAt,
      riskScore: 7.5,
      cveCount: 3,
      criticalCount: 1,
      highCount: 1,
      mediumCount: 1,
      lowCount: 0,
      licenseCount: 5,
      licenseIssues: 2,
    }]);
    const req = new NextRequest('http://localhost/api/history?repoId=repo-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      history: Array<{
        scanId: string;
        scannedAt: string;
        riskScore: number;
        cveCount: number;
        criticalCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        licenseCount: number;
        licenseIssues: number;
      }>;
    };
    expect(body.history).toHaveLength(1);
    const entry = body.history[0];
    expect(entry.scanId).toBe('scan-1');
    expect(entry.scannedAt).toBe(scannedAt.toISOString());
    expect(entry.riskScore).toBe(7.5);
    expect(entry.cveCount).toBe(3);
    expect(entry.criticalCount).toBe(1);
    expect(entry.highCount).toBe(1);
    expect(entry.mediumCount).toBe(1);
    expect(entry.lowCount).toBe(0);
    expect(entry.licenseCount).toBe(5);
    expect(entry.licenseIssues).toBe(2);
  });

  it('caps the take at 100 when limit exceeds 100', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1', fullName: 'owner/repo' });
    scanFindMany.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/history?repoId=repo-1&limit=9999');
    await GET(req);
    expect(scanFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('respects a limit value within the cap (e.g. limit=10)', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1', fullName: 'owner/repo' });
    scanFindMany.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/history?repoId=repo-1&limit=10');
    await GET(req);
    expect(scanFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });
});
