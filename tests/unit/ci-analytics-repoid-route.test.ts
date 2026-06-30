// Route-level tests for GET /api/ci/analytics/[repoId].
// Covers period coercion, all type branches, ownership check, and 500 path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  repoFindFirst,
  getWorkflowFailRatesMock,
  getWorkflowBuildTimesMock,
  detectFlakyJobsMock,
  getBottlenecksMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  repoFindFirst: vi.fn(),
  getWorkflowFailRatesMock: vi.fn(),
  getWorkflowBuildTimesMock: vi.fn(),
  detectFlakyJobsMock: vi.fn(),
  getBottlenecksMock: vi.fn(),
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
  },
}));

vi.mock('@/lib/ci/analytics/fail-rate', () => ({
  getWorkflowFailRates: getWorkflowFailRatesMock,
}));

vi.mock('@/lib/ci/analytics/build-times', () => ({
  getWorkflowBuildTimes: getWorkflowBuildTimesMock,
}));

vi.mock('@/lib/ci/analytics/flaky', () => ({
  detectFlakyJobs: detectFlakyJobsMock,
}));

vi.mock('@/lib/ci/analytics/bottleneck', () => ({
  getBottlenecks: getBottlenecksMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/ci/analytics/[repoId]/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

function makeParams(repoId: string) {
  return { params: Promise.resolve({ repoId }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/ci/analytics/[repoId]', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    repoFindFirst.mockReset();
    getWorkflowFailRatesMock.mockReset();
    getWorkflowBuildTimesMock.mockReset();
    detectFlakyJobsMock.mockReset();
    getBottlenecksMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=fail-rate');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 404 when repo is not owned and verifies ownership where clause', async () => {
    repoFindFirst.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=fail-rate');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repo not found');
    expect(repoFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'user-1' },
      select: { id: true },
    });
  });

  it('returns 400 for an unknown type value', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=unknown-type');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Unknown type');
    expect(body.error).toContain('unknown-type');
  });

  it('returns 200 for type=fail-rate with period=7 and uses the OWNERSHIP-VERIFIED repo id', async () => {
    // The owned repo.id deliberately differs from the path param so this test
    // distinguishes the security hardening (analytics keyed on repo.id, the
    // ownership-verified id) from the raw, attacker-controlled path param.
    repoFindFirst.mockResolvedValue({ id: 'owned-99' });
    getWorkflowFailRatesMock.mockResolvedValue([{ workflow: 'CI', failRate: 0.1 }]);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=fail-rate&period=7');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; period: number; data: Array<{ workflow: string; failRate: number }> };
    expect(body.type).toBe('fail-rate');
    expect(body.period).toBe(7);
    expect(body.data).toEqual([{ workflow: 'CI', failRate: 0.1 }]);
    // Must be the owned id 'owned-99', NOT the path param 'repo-1'.
    expect(getWorkflowFailRatesMock).toHaveBeenCalledWith('owned-99', 7);
  });

  it('coerces an invalid period value (99) to 30', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    getWorkflowFailRatesMock.mockResolvedValue([]);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=fail-rate&period=99');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { period: number };
    expect(body.period).toBe(30);
    expect(getWorkflowFailRatesMock).toHaveBeenCalledWith('repo-1', 30);
  });

  it('returns 200 for type=build-times with default period=30', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    getWorkflowBuildTimesMock.mockResolvedValue([{ avg: 120 }]);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=build-times');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; period: number; data: unknown[] };
    expect(body.type).toBe('build-times');
    expect(body.period).toBe(30);
    expect(body.data).toEqual([{ avg: 120 }]);
    expect(getWorkflowBuildTimesMock).toHaveBeenCalledWith('repo-1', 30);
  });

  it('returns 200 for type=flaky with period=1 and verifies detectFlakyJobs call shape', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    detectFlakyJobsMock.mockResolvedValue([{ job: 'test', flakyRate: 0.25 }]);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=flaky&period=1');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; period: number; data: unknown[] };
    expect(body.type).toBe('flaky');
    expect(body.period).toBe(1);
    // Route wraps period in an object for detectFlakyJobs
    expect(detectFlakyJobsMock).toHaveBeenCalledWith('repo-1', { period: 1 });
  });

  it('returns 200 for type=bottleneck with verifies getBottlenecks call args', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    getBottlenecksMock.mockResolvedValue([{ step: 'build', avgMs: 5000 }]);
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=bottleneck&period=30');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; period: number; data: unknown[] };
    expect(body.type).toBe('bottleneck');
    expect(body.period).toBe(30);
    expect(body.data).toEqual([{ step: 'build', avgMs: 5000 }]);
    expect(getBottlenecksMock).toHaveBeenCalledWith('repo-1', 30);
  });

  it('returns 500 with error message when an analytics fn throws', async () => {
    repoFindFirst.mockResolvedValue({ id: 'repo-1' });
    getWorkflowFailRatesMock.mockRejectedValue(new Error('DB connection lost'));
    const req = new NextRequest('http://localhost/api/ci/analytics/repo-1?type=fail-rate');
    const res = await GET(req, makeParams('repo-1'));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('DB connection lost');
  });
});
