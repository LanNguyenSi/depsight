// Route-level tests for POST /api/repos/sync.
// Uses auth() (PATTERN B). Route fetches GitHub repos then syncs them into DB.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, getTokenMock, getUserReposMock, syncUserReposMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getTokenMock: vi.fn(),
  getUserReposMock: vi.fn(),
  syncUserReposMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/auth-api', () => ({ getSessionGitHubToken: getTokenMock }));

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
import { reposRateLimiter, REPOS_LIMIT_PER_HOUR } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1' } };

const GITHUB_REPOS = [
  { id: 1, name: 'api', fullName: 'acme/api', private: false, defaultBranch: 'main', language: 'TypeScript', owner: { login: 'acme' }, archived: false },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/repos/sync', () => {
  beforeEach(() => {
    reposRateLimiter.reset();
    authMock.mockReset();
    // The session carries no GitHub token; the route reads it server side by user id.
    getTokenMock.mockReset();
    getTokenMock.mockImplementation(async (userId: string) => ({ 'user-1': 'tok-123' } as Record<string, string>)[userId] ?? '');
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

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: {} });

    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(getUserReposMock).not.toHaveBeenCalled();
    expect(syncUserReposMock).not.toHaveBeenCalled();
  });

  it('(2) returns 200 {synced, removed} on happy path', async () => {
    authMock.mockResolvedValue(SESSION);
    getUserReposMock.mockResolvedValue(GITHUB_REPOS);
    syncUserReposMock.mockResolvedValue({ syncedCount: 5, removedCount: 1, archivedCount: 2 });

    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json() as { synced: number; removed: number; archived: number };
    expect(body.synced).toBe(5);
    expect(body.removed).toBe(1);
    expect(body.archived).toBe(2);
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

// ---------------------------------------------------------------------------
// The GitHub token is read server side, never from the session
// ---------------------------------------------------------------------------
describe('POST /api/repos/sync: GitHub token source', () => {
  beforeEach(() => {
    reposRateLimiter.reset();
    authMock.mockReset();
    getUserReposMock.mockReset();
    syncUserReposMock.mockReset();
    getTokenMock.mockReset();
    syncUserReposMock.mockResolvedValue({ syncedCount: 0, removedCount: 0, archivedCount: 0 });
  });

  it('looks the token up by the session user id and ignores a token field on the session', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', githubToken: 'from-session' } });
    getTokenMock.mockResolvedValue('from-db');
    getUserReposMock.mockResolvedValue([]);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(getTokenMock).toHaveBeenCalledWith('user-1');
    expect(getUserReposMock).toHaveBeenCalledWith('from-db');
  });

  it('passes an empty token on as it is for a user without a stored token (same call as before)', async () => {
    authMock.mockResolvedValue(SESSION);
    getTokenMock.mockResolvedValue('');
    getUserReposMock.mockResolvedValue([]);

    await POST();

    expect(getUserReposMock).toHaveBeenCalledWith('');
  });
});

// ---------------------------------------------------------------------------
// Per-user rate limit (shared with GET /api/repos)
// ---------------------------------------------------------------------------
describe('POST /api/repos/sync: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    reposRateLimiter.reset();
    authMock.mockReset();
    getUserReposMock.mockReset();
    syncUserReposMock.mockReset();
    getTokenMock.mockReset();
    getTokenMock.mockResolvedValue('tok-123');
    getUserReposMock.mockResolvedValue([]);
    syncUserReposMock.mockResolvedValue({ syncedCount: 0, removedCount: 0, archivedCount: 0 });
    authMock.mockResolvedValue(SESSION);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 429 with Retry-After once the user is over the limit, without calling GitHub', async () => {
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR; i++) {
      expect((await POST()).status).toBe(200);
    }
    expect(getUserReposMock).toHaveBeenCalledTimes(REPOS_LIMIT_PER_HOUR);

    const res = await POST();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(getUserReposMock).toHaveBeenCalledTimes(REPOS_LIMIT_PER_HOUR);
    expect(getTokenMock).toHaveBeenCalledTimes(REPOS_LIMIT_PER_HOUR);
  });

  it('limits per user and does not count an unauthenticated request', async () => {
    authMock.mockResolvedValue(null);
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST()).status).toBe(401);
    }

    authMock.mockResolvedValue(SESSION);
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR; i++) await POST();
    expect((await POST()).status).toBe(429);

    authMock.mockResolvedValue({ user: { id: 'someone-else' } });
    expect((await POST()).status).toBe(200);
  });
});
