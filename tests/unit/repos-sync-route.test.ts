// Route-level tests for POST /api/repos/sync.
// Uses auth() (PATTERN B). Route fetches GitHub repos then syncs them into DB.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, getUserReposMock, syncUserReposMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getUserReposMock: vi.fn(),
  syncUserReposMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));

// getUserRepos is the token-based GitHub fetch; mock at module boundary.
vi.mock('@/lib/github', () => ({
  getUserRepos: getUserReposMock,
  // createGitHubClient is not used by this route — no need to mock
}));

// syncUserRepos receives (prisma, userId, githubRepos); mock out the whole fn.
vi.mock('@/lib/repos/sync', () => ({
  syncUserRepos: syncUserReposMock,
}));

// prisma is imported and passed as a parameter to syncUserRepos.
// We do NOT need to mock @/lib/prisma at method level; the mock above captures
// the call. But we must mock the module so the import resolves without a real
// DB connection (Next.js module resolution will try to load it).
vi.mock('@/lib/prisma', () => ({
  prisma: {},
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/repos/sync/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

const GITHUB_REPOS = [
  { id: 1, name: 'api', fullName: 'acme/api', private: false, defaultBranch: 'main', language: 'TypeScript', owner: { login: 'acme' }, archived: false },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/repos/sync', () => {
  beforeEach(() => {
    authMock.mockReset();
    getUserReposMock.mockReset();
    syncUserReposMock.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(getUserReposMock).not.toHaveBeenCalled();
  });

  it('(2) returns 200 {synced, removed} on happy path', async () => {
    authMock.mockResolvedValue(SESSION);
    getUserReposMock.mockResolvedValue(GITHUB_REPOS);
    syncUserReposMock.mockResolvedValue({ syncedCount: 5, removedCount: 1 });

    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json() as { synced: number; removed: number };
    expect(body.synced).toBe(5);
    expect(body.removed).toBe(1);
    expect(getUserReposMock).toHaveBeenCalledWith('tok-123');
    // syncUserRepos is called with prisma, userId, and the github repos
    expect(syncUserReposMock).toHaveBeenCalledWith(
      expect.anything(), // the prisma mock object
      'user-1',
      GITHUB_REPOS,
    );
  });

  it('(3) returns 500 when getUserRepos throws', async () => {
    authMock.mockResolvedValue(SESSION);
    getUserReposMock.mockRejectedValue(new Error('GitHub API unavailable'));

    const res = await POST();

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('GitHub API unavailable');
    expect(syncUserReposMock).not.toHaveBeenCalled();
  });

  it('(4) returns 500 when syncUserRepos throws', async () => {
    authMock.mockResolvedValue(SESSION);
    getUserReposMock.mockResolvedValue(GITHUB_REPOS);
    syncUserReposMock.mockRejectedValue(new Error('Database write failed'));

    const res = await POST();

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Database write failed');
  });

  it('(5) returns 200 with zero counts when sync reports nothing changed', async () => {
    authMock.mockResolvedValue(SESSION);
    getUserReposMock.mockResolvedValue([]);
    syncUserReposMock.mockResolvedValue({ syncedCount: 0, removedCount: 0 });

    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json() as { synced: number; removed: number };
    expect(body.synced).toBe(0);
    expect(body.removed).toBe(0);
  });
});
