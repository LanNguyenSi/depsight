// Route-level tests for GET /api/repos/tracked-ids.
// Uses resolveRequestUser (PATTERN A, same as GET /api/repos). This route
// must stay cheap: it reads only the tracked Repo rows' id/githubId and
// never calls getTeamHealthOverview.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { resolveRequestUserMock, getTrackedRepoIdsMock } = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  getTrackedRepoIdsMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock('@/lib/repos/tracked-ids', () => ({
  getTrackedRepoIds: getTrackedRepoIdsMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/repos/tracked-ids/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/repos/tracked-ids', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    getTrackedRepoIdsMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(getTrackedRepoIdsMock).not.toHaveBeenCalled();
  });

  it('returns 200 with the tracked repoId/githubId pairs, calling getTrackedRepoIds with the resolved userId', async () => {
    const rows = [
      { repoId: 'repo-cuid-1', githubId: 10001001 },
      { repoId: 'repo-cuid-2', githubId: 20002002 },
    ];
    getTrackedRepoIdsMock.mockResolvedValue(rows);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: typeof rows };
    expect(body.repos).toEqual(rows);
    expect(getTrackedRepoIdsMock).toHaveBeenCalledWith('user-1');
  });

  it('returns 200 with an empty repos array when nothing is tracked', async () => {
    getTrackedRepoIdsMock.mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: unknown[] };
    expect(body.repos).toEqual([]);
  });

  it('returns 500 with the underlying error message when getTrackedRepoIds throws', async () => {
    getTrackedRepoIdsMock.mockRejectedValue(new Error('Database unreachable'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Database unreachable');
  });

  it('returns 500 with a generic message when a non-Error is thrown', async () => {
    getTrackedRepoIdsMock.mockRejectedValue('boom');
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to load tracked repo ids');
  });
});
