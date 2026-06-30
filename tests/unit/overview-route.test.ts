// Route-level tests for GET /api/overview.
// Covers 401, happy path with exact userId arg assertion, and 500 path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  getTeamHealthOverviewMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  getTeamHealthOverviewMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock('@/lib/overview/team-health', () => ({
  getTeamHealthOverview: getTeamHealthOverviewMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/overview/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/overview', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    getTeamHealthOverviewMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 200 with overview data and verifies getTeamHealthOverview called with userId', async () => {
    getTeamHealthOverviewMock.mockResolvedValue({ totalRepos: 5, criticalRepos: 1, avgRisk: 3.2 });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { totalRepos: number; criticalRepos: number; avgRisk: number };
    expect(body.totalRepos).toBe(5);
    expect(body.criticalRepos).toBe(1);
    expect(body.avgRisk).toBe(3.2);
    expect(getTeamHealthOverviewMock).toHaveBeenCalledWith('user-1');
  });

  it('returns 500 with error message when getTeamHealthOverview throws', async () => {
    getTeamHealthOverviewMock.mockRejectedValue(new Error('overview failed'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('overview failed');
  });
});
