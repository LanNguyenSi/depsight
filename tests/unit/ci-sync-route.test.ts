// Route-level tests for POST /api/ci/sync.
// The route resolves its caller through the real resolveRequestUser (auth +
// headers + apiToken lookup are the only stubs), so a browser session and a
// Bearer dsat_ token are both covered. Body {repoId} triggers single-repo
// sync; omitting repoId (or sending an empty body) triggers all-repos sync.
// A sync persists data and spends GitHub quota, so a READ token gets 403.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  authMock,
  headersMock,
  apiTokenFindUnique,
  apiTokenUpdate,
  repoFindFirst,
  syncRepoByIdMock,
  syncAllUserReposMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  headersMock: vi.fn(),
  apiTokenFindUnique: vi.fn(),
  apiTokenUpdate: vi.fn(),
  repoFindFirst: vi.fn(),
  syncRepoByIdMock: vi.fn(),
  syncAllUserReposMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiToken: {
      findUnique: apiTokenFindUnique,
      update: apiTokenUpdate,
    },
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
import {
  ciSyncRepoRateLimiter,
  ciSyncAllRateLimiter,
  CI_SYNC_REPO_LIMIT_PER_HOUR,
  CI_SYNC_ALL_LIMIT_PER_HOUR,
} from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

function buildHeaders(map: Record<string, string>) {
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

function mockBearerToken(scope: 'READ' | 'WRITE') {
  authMock.mockResolvedValue(null);
  headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_valid' }));
  apiTokenFindUnique.mockResolvedValue({
    id: 'tok-1',
    revokedAt: null,
    scope,
    user: { id: 'token-owner', githubLogin: 'agent', githubToken: 'gh_tok' },
  });
}

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
    ciSyncRepoRateLimiter.reset();
    ciSyncAllRateLimiter.reset();
    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUnique.mockReset();
    apiTokenUpdate.mockReset();
    repoFindFirst.mockReset();
    syncRepoByIdMock.mockReset();
    syncAllUserReposMock.mockReset();
    apiTokenUpdate.mockResolvedValue({});
    // Default: no Authorization header (browser-session tests).
    headersMock.mockResolvedValue(buildHeaders({}));
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
  describe('Bearer dsat_ token access', () => {
    it('(7) a READ-scoped token gets 403 and nothing is synced', async () => {
      mockBearerToken('READ');

      const res = await POST(makePostRequest({ repoId: 'r1' }));

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('This token does not have write access');
      expect(repoFindFirst).not.toHaveBeenCalled();
      expect(syncRepoByIdMock).not.toHaveBeenCalled();
      expect(syncAllUserReposMock).not.toHaveBeenCalled();
    });

    it('(8) a WRITE-scoped token syncs one repo, with the ownership check scoped to the token owner', async () => {
      mockBearerToken('WRITE');
      repoFindFirst.mockResolvedValue({ id: 'r1' });
      syncRepoByIdMock.mockResolvedValue({ runsIngested: 2 });

      const res = await POST(makePostRequest({ repoId: 'r1' }));

      expect(res.status).toBe(200);
      expect(repoFindFirst).toHaveBeenCalledWith({
        where: { id: 'r1', userId: 'token-owner' },
        select: { id: true },
      });
      expect(syncRepoByIdMock).toHaveBeenCalledWith('r1', { daysBack: 30 });
    });

    it('(9) a WRITE-scoped token without repoId syncs all repos of the token owner only', async () => {
      mockBearerToken('WRITE');
      syncAllUserReposMock.mockResolvedValue({ reposAttempted: 1 });

      const res = await POST(makePostRequest({}));

      expect(res.status).toBe(200);
      expect(syncAllUserReposMock).toHaveBeenCalledWith('token-owner', { daysBack: 30 });
    });

    it('(10) a WRITE-scoped token cannot sync a repo it does not own (404)', async () => {
      mockBearerToken('WRITE');
      repoFindFirst.mockResolvedValue(null);

      const res = await POST(makePostRequest({ repoId: 'someone-elses-repo' }));

      expect(res.status).toBe(404);
      expect(syncRepoByIdMock).not.toHaveBeenCalled();
    });

    it('(11) an unknown dsat_ token gets 401', async () => {
      authMock.mockResolvedValue(null);
      headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_unknown' }));
      apiTokenFindUnique.mockResolvedValue(null);

      const res = await POST(makePostRequest({ repoId: 'r1' }));

      expect(res.status).toBe(401);
      expect(syncRepoByIdMock).not.toHaveBeenCalled();
    });

    it('(12) a revoked dsat_ token gets 401', async () => {
      authMock.mockResolvedValue(null);
      headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_revoked' }));
      apiTokenFindUnique.mockResolvedValue({
        id: 'tok-2',
        revokedAt: new Date('2026-01-01T00:00:00Z'),
        scope: 'WRITE',
        user: { id: 'token-owner', githubLogin: 'agent', githubToken: 'gh_tok' },
      });

      const res = await POST(makePostRequest({ repoId: 'r1' }));

      expect(res.status).toBe(401);
      expect(syncRepoByIdMock).not.toHaveBeenCalled();
    });

    it('(13) a browser session keeps full access (resolves to WRITE)', async () => {
      authMock.mockResolvedValue(SESSION);
      syncAllUserReposMock.mockResolvedValue({ reposAttempted: 0 });

      const res = await POST(makePostRequest({}));

      expect(res.status).toBe(200);
    });
  });
});

describe('POST /api/ci/sync: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    ciSyncRepoRateLimiter.reset();
    ciSyncAllRateLimiter.reset();
    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUnique.mockReset();
    apiTokenUpdate.mockReset();
    repoFindFirst.mockReset();
    syncRepoByIdMock.mockReset();
    syncAllUserReposMock.mockReset();
    apiTokenUpdate.mockResolvedValue({});
    headersMock.mockResolvedValue(buildHeaders({}));
    repoFindFirst.mockResolvedValue({ id: 'r1' });
    syncRepoByIdMock.mockResolvedValue({ ok: true });
    syncAllUserReposMock.mockResolvedValue({ reposAttempted: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 429 with Retry-After for the all-repos sync once the user is over its budget, without syncing', async () => {
    authMock.mockResolvedValue(SESSION);
    for (let i = 0; i < CI_SYNC_ALL_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({}))).status).toBe(200);
    }
    expect(syncAllUserReposMock).toHaveBeenCalledTimes(CI_SYNC_ALL_LIMIT_PER_HOUR);

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.retryAfterSeconds).toBe(WINDOW_MS / 1000);
    expect(syncAllUserReposMock).toHaveBeenCalledTimes(CI_SYNC_ALL_LIMIT_PER_HOUR);
  });

  it('applies the limit to a WRITE Bearer token, keyed by the token owner, not only to a browser session', async () => {
    mockBearerToken('WRITE');
    for (let i = 0; i < CI_SYNC_ALL_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({}))).status).toBe(200);
    }

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(429);
    expect(syncAllUserReposMock).toHaveBeenCalledTimes(CI_SYNC_ALL_LIMIT_PER_HOUR);
    expect(syncAllUserReposMock).toHaveBeenCalledWith('token-owner', { daysBack: 30 });

    // the browser session of a different user is a different bucket
    authMock.mockResolvedValue(SESSION);
    headersMock.mockResolvedValue(buildHeaders({}));
    expect((await POST(makePostRequest({}))).status).toBe(200);
  });

  it('answers 429 for the single-repo sync once its larger budget is spent, and the budgets are separate', async () => {
    authMock.mockResolvedValue(SESSION);
    for (let i = 0; i < CI_SYNC_REPO_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ repoId: 'r1' }))).status).toBe(200);
    }

    const blocked = await POST(makePostRequest({ repoId: 'r1' }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    expect(syncRepoByIdMock).toHaveBeenCalledTimes(CI_SYNC_REPO_LIMIT_PER_HOUR);

    // all-repos budget is untouched
    expect((await POST(makePostRequest({}))).status).toBe(200);
  });

  it('allows the sync again after the window has elapsed', async () => {
    authMock.mockResolvedValue(SESSION);
    for (let i = 0; i < CI_SYNC_ALL_LIMIT_PER_HOUR; i++) {
      await POST(makePostRequest({}));
    }
    vi.advanceTimersByTime(WINDOW_MS - 1_000);
    expect((await POST(makePostRequest({}))).status).toBe(429);

    vi.advanceTimersByTime(1_000);
    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(200);
  });

  it('does not count a READ-token request (403) against the budget', async () => {
    mockBearerToken('READ');
    for (let i = 0; i < CI_SYNC_ALL_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest({}))).status).toBe(403);
    }
    mockBearerToken('WRITE');

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(200);
  });
});
