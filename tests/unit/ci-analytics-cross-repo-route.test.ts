// Route-level tests for GET /api/ci/analytics/cross-repo.
// Covers 401, period coercion to [1,7,30], and summaries passthrough.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  getAllCIHealthSummariesMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  getAllCIHealthSummariesMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock('@/lib/ci/analytics/cross-repo', () => ({
  getAllCIHealthSummaries: getAllCIHealthSummariesMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/ci/analytics/cross-repo/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/ci/analytics/cross-repo', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    getAllCIHealthSummariesMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/ci/analytics/cross-repo');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 200 with summaries and default period=30 when no period param provided', async () => {
    getAllCIHealthSummariesMock.mockResolvedValue([{ repoId: 'r1', health: 0.9 }]);
    const req = new NextRequest('http://localhost/api/ci/analytics/cross-repo');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { period: number; summaries: Array<{ repoId: string; health: number }> };
    expect(body.period).toBe(30);
    expect(body.summaries).toEqual([{ repoId: 'r1', health: 0.9 }]);
    expect(getAllCIHealthSummariesMock).toHaveBeenCalledWith('user-1', 30);
  });

  it('passes valid period=7 to getAllCIHealthSummaries', async () => {
    getAllCIHealthSummariesMock.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/ci/analytics/cross-repo?period=7');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { period: number; summaries: unknown[] };
    expect(body.period).toBe(7);
    expect(body.summaries).toEqual([]);
    expect(getAllCIHealthSummariesMock).toHaveBeenCalledWith('user-1', 7);
  });

  it('passes valid period=1 to getAllCIHealthSummaries', async () => {
    getAllCIHealthSummariesMock.mockResolvedValue([{ repoId: 'r2', health: 0.5 }]);
    const req = new NextRequest('http://localhost/api/ci/analytics/cross-repo?period=1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { period: number };
    expect(body.period).toBe(1);
    expect(getAllCIHealthSummariesMock).toHaveBeenCalledWith('user-1', 1);
  });

  it('coerces an invalid period value (42) to 30', async () => {
    getAllCIHealthSummariesMock.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/ci/analytics/cross-repo?period=42');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { period: number };
    expect(body.period).toBe(30);
    expect(getAllCIHealthSummariesMock).toHaveBeenCalledWith('user-1', 30);
  });
});
