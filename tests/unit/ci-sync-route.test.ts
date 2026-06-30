// Route-level tests for POST /api/ci/sync.
// Uses auth() (PATTERN B). Body {repoId} triggers single-repo sync;
// omitting repoId (or sending an empty body) triggers all-repos sync.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, repoFindFirst, syncRepoByIdMock, syncAllUserReposMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  repoFindFirst: vi.fn(),
  syncRepoByIdMock: vi.fn(),
  syncAllUserReposMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findFirst: repoFindFirst,
    },
  },
}));
vi.mock('@/lib/ci/sync', () => ({
  syncRepoById: syncRepoByIdMock,
  syncAllUserRepos: syncAllUserReposMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/ci/sync/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

function makePostRequest(body?: Record<string, unknown>): NextRequest {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new NextRequest('http://localhost/api/ci/sync', init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/ci/sync', () => {
  beforeEach(() => {
    authMock.mockReset();
    repoFindFirst.mockReset();
    syncRepoByIdMock.mockReset();
    syncAllUserReposMock.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ repoId: 'r1' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(repoFindFirst).not.toHaveBeenCalled();
  });

  it('(2) returns 404 when repoId given but repo not found/owned — asserts exact where clause', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindFirst.mockResolvedValue(null);

    const res = await POST(makePostRequest({ repoId: 'missing-repo' }));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repo not found');
    expect(repoFindFirst).toHaveBeenCalledWith({
      where: { id: 'missing-repo', userId: 'user-1' },
      select: { id: true },
    });
    expect(syncRepoByIdMock).not.toHaveBeenCalled();
  });

  it('(3) returns 200 {result} on single-repo sync success', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    const syncResult = { runs: 5, added: 3, updated: 2 };
    syncRepoByIdMock.mockResolvedValue(syncResult);

    const res = await POST(makePostRequest({ repoId: 'r1' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { result: typeof syncResult };
    expect(body.result).toEqual(syncResult);
    expect(syncRepoByIdMock).toHaveBeenCalledWith('r1', { daysBack: 30 });
  });

  it('(4) returns 500 when syncRepoById throws', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    syncRepoByIdMock.mockRejectedValue(new Error('GitHub rate limit exceeded'));

    const res = await POST(makePostRequest({ repoId: 'r1' }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('GitHub rate limit exceeded');
  });

  it('(5) no repoId in body → all-repos path, returns 200 {summary}', async () => {
    authMock.mockResolvedValue(SESSION);
    const summary = { synced: 10, failed: 1 };
    syncAllUserReposMock.mockResolvedValue(summary);

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(200);
    const body = await res.json() as { summary: typeof summary };
    expect(body.summary).toEqual(summary);
    expect(syncAllUserReposMock).toHaveBeenCalledWith('user-1', { daysBack: 30 });
    expect(repoFindFirst).not.toHaveBeenCalled();
  });

  it('(6) empty/missing body is tolerated (JSON parse catches) → all-repos path', async () => {
    authMock.mockResolvedValue(SESSION);
    syncAllUserReposMock.mockResolvedValue({ synced: 0, failed: 0 });

    // Send a request with no body at all (no content-type header either)
    const res = await POST(makePostRequest());

    expect(res.status).toBe(200);
    const body = await res.json() as { summary: unknown };
    expect(body).toHaveProperty('summary');
    expect(syncAllUserReposMock).toHaveBeenCalledWith('user-1', { daysBack: 30 });
  });
});
