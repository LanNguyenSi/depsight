// Route-level tests for GET /api/repos.
// Covers 401, 400 for missing/falsy githubToken, 200 happy path, and 500 path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
