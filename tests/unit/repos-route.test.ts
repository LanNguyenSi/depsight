// Route-level tests for GET /api/repos.
// Covers 401, 400 for missing/falsy githubToken, 200 happy path, 500 path,
// the archived-by-default filter (including a payload without the field) and
// the exact `includeArchived=true` opt-out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  getUserReposMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  getUserReposMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock('@/lib/github', () => ({
  getUserRepos: getUserReposMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/repos/route';
import { NextRequest } from 'next/server';
import { reposRateLimiter, REPOS_LIMIT_PER_HOUR } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

function makeGetRequest(query?: string): NextRequest {
  return new NextRequest(`http://localhost/api/repos${query ? `?${query}` : ''}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/repos', () => {
  beforeEach(() => {
    reposRateLimiter.reset();
    resolveRequestUserMock.mockReset();
    getUserReposMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when user.githubToken is an empty string', async () => {
    resolveRequestUserMock.mockResolvedValue({ id: 'user-1', githubLogin: 'octocat', githubToken: '' });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('No GitHub token found');
  });

  it('returns 400 when user.githubToken is null', async () => {
    resolveRequestUserMock.mockResolvedValue({ id: 'user-1', githubLogin: 'octocat', githubToken: null });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('No GitHub token found');
  });

  it('returns 200 with repos list and verifies getUserRepos called with githubToken', async () => {
    const mockRepos = [
      { id: 1, full_name: 'octocat/hello-world', private: false, archived: false },
      { id: 2, full_name: 'octocat/fork', private: true, archived: false },
    ];
    getUserReposMock.mockResolvedValue(mockRepos);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: typeof mockRepos };
    expect(body.repos).toEqual(mockRepos);
    expect(getUserReposMock).toHaveBeenCalledWith('gh_tok');
  });

  it('returns 500 with generic message when getUserRepos throws', async () => {
    getUserReposMock.mockRejectedValue(new Error('GitHub API unreachable'));
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    // Route returns a static message, not the underlying error
    expect(body.error).toBe('Failed to fetch repositories');
  });

  it('filters out archived repos by default', async () => {
    const mockRepos = [
      { id: 1, full_name: 'octocat/hello-world', private: false, archived: false },
      { id: 2, full_name: 'octocat/old-project', private: false, archived: true },
    ];
    getUserReposMock.mockResolvedValue(mockRepos);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: typeof mockRepos };
    expect(body.repos).toEqual([mockRepos[0]]);
  });

  it('includes archived repos when includeArchived=true is passed', async () => {
    const mockRepos = [
      { id: 1, full_name: 'octocat/hello-world', private: false, archived: false },
      { id: 2, full_name: 'octocat/old-project', private: false, archived: true },
    ];
    getUserReposMock.mockResolvedValue(mockRepos);
    const res = await GET(makeGetRequest('includeArchived=true'));
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: typeof mockRepos };
    expect(body.repos).toEqual(mockRepos);
  });

  it('keeps repos whose payload lacks the archived field (fail-open, mirrors the sync rule)', async () => {
    const mockRepos = [
      { id: 1, full_name: 'octocat/hello-world', private: false },
      { id: 2, full_name: 'octocat/old-project', private: false, archived: true },
    ];
    getUserReposMock.mockResolvedValue(mockRepos);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: typeof mockRepos };
    expect(body.repos).toEqual([mockRepos[0]]);
  });

  it('treats any spelling other than includeArchived=true as the default (archived filtered)', async () => {
    const mockRepos = [
      { id: 1, full_name: 'octocat/hello-world', private: false, archived: false },
      { id: 2, full_name: 'octocat/old-project', private: false, archived: true },
    ];
    getUserReposMock.mockResolvedValue(mockRepos);
    const res = await GET(makeGetRequest('includeArchived=1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: typeof mockRepos };
    expect(body.repos).toEqual([mockRepos[0]]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/repos: per-user rate limit
// ---------------------------------------------------------------------------
describe('GET /api/repos: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    reposRateLimiter.reset();
    resolveRequestUserMock.mockReset();
    getUserReposMock.mockReset();
    getUserReposMock.mockResolvedValue([]);
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('budgets 300 calls per user and hour, like the sibling limiters', () => {
    expect(REPOS_LIMIT_PER_HOUR).toBe(300);
  });

  it('answers 429 with Retry-After once the user is over the limit, without calling GitHub', async () => {
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR; i++) {
      expect((await GET(makeGetRequest())).status).toBe(200);
    }
    expect(getUserReposMock).toHaveBeenCalledTimes(REPOS_LIMIT_PER_HOUR);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(getUserReposMock).toHaveBeenCalledTimes(REPOS_LIMIT_PER_HOUR);
  });

  it('limits per user and allows requests again after the window has elapsed', async () => {
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR; i++) {
      await GET(makeGetRequest());
    }
    expect((await GET(makeGetRequest())).status).toBe(429);

    resolveRequestUserMock.mockResolvedValue({ ...mockUser, id: 'someone-else' });
    expect((await GET(makeGetRequest())).status).toBe(200);

    resolveRequestUserMock.mockResolvedValue(mockUser);
    vi.advanceTimersByTime(WINDOW_MS);
    expect((await GET(makeGetRequest())).status).toBe(200);
  });

  it('does not count an unauthenticated request', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR + 3; i++) {
      expect((await GET(makeGetRequest())).status).toBe(401);
    }

    resolveRequestUserMock.mockResolvedValue(mockUser);
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR; i++) {
      expect((await GET(makeGetRequest())).status).toBe(200);
    }
    expect((await GET(makeGetRequest())).status).toBe(429);
  });

  it('counts a request answered 400 for a missing GitHub token', async () => {
    resolveRequestUserMock.mockResolvedValue({ ...mockUser, githubToken: '' });
    for (let i = 0; i < REPOS_LIMIT_PER_HOUR; i++) {
      expect((await GET(makeGetRequest())).status).toBe(400);
    }

    resolveRequestUserMock.mockResolvedValue(mockUser);
    expect((await GET(makeGetRequest())).status).toBe(429);
    expect(getUserReposMock).not.toHaveBeenCalled();
  });
});
