// Route-level tests for POST /api/pr-scan.
// Uses auth() (PATTERN B).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, getTokenMock, scanPRAndCommentMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getTokenMock: vi.fn(),
  scanPRAndCommentMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/auth-api', () => ({ getSessionGitHubToken: getTokenMock }));
vi.mock('@/lib/pr/pr-scanner', () => ({
  scanPRAndComment: scanPRAndCommentMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/pr-scan/route';
import { NextRequest } from 'next/server';
import { prScanRateLimiter, PR_SCAN_LIMIT_PER_HOUR } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1' } };

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pr-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/pr-scan', () => {
  beforeEach(() => {
    prScanRateLimiter.reset();
    authMock.mockReset();
    // The session carries no GitHub token; the route reads it server side by user id.
    getTokenMock.mockReset();
    getTokenMock.mockImplementation(async (userId: string) => ({ 'user-1': 'tok-123' } as Record<string, string>)[userId] ?? '');
    scanPRAndCommentMock.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 42 }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: {} });

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 42 }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('(2) returns 400 when owner is missing', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({ repo: 'api', prNumber: 1 }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('owner, repo, and prNumber are required');
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('(3) returns 400 when repo is missing', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({ owner: 'acme', prNumber: 1 }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('owner, repo, and prNumber are required');
  });

  it('(4) returns 400 when prNumber is missing', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('owner, repo, and prNumber are required');
  });

  it('(5) returns 400 when prNumber is 0 — caught by the falsy guard (required error)', async () => {
    authMock.mockResolvedValue(SESSION);

    // 0 is falsy so !prNumber === true; hits the "required" guard before the integer check
    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 0 }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('owner, repo, and prNumber are required');
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('(6) returns 400 when prNumber is a negative integer', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: -5 }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('prNumber must be a positive integer');
  });

  it('(7) returns 400 when prNumber is a non-integer float', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 1.5 }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('prNumber must be a positive integer');
  });

  it('(8) returns 200 {success:true,...result} on happy path — asserts scanPRAndComment args', async () => {
    authMock.mockResolvedValue(SESSION);
    const scanResult = { commentUrl: 'https://github.com/acme/api/pull/42#issuecomment-1', cveCount: 2 };
    scanPRAndCommentMock.mockResolvedValue(scanResult);

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 42 }));

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; commentUrl: string; cveCount: number };
    expect(body.success).toBe(true);
    expect(body.commentUrl).toBe(scanResult.commentUrl);
    expect(body.cveCount).toBe(2);
    expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-123', 'acme', 'api', 42, 'user-1');
  });

  it('(9) returns 500 when scanPRAndComment throws', async () => {
    authMock.mockResolvedValue(SESSION);
    scanPRAndCommentMock.mockRejectedValue(new Error('GitHub API error'));

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 1 }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('GitHub API error');
  });
});

// ---------------------------------------------------------------------------
// The GitHub token is read server side, never from the session
// ---------------------------------------------------------------------------
describe('POST /api/pr-scan: GitHub token source', () => {
  beforeEach(() => {
    prScanRateLimiter.reset();
    authMock.mockReset();
    scanPRAndCommentMock.mockReset();
    getTokenMock.mockReset();
    scanPRAndCommentMock.mockResolvedValue({ cveCount: 0 });
  });

  it('looks the token up by the session user id and ignores a token field on the session', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', githubToken: 'from-session' } });
    getTokenMock.mockResolvedValue('from-db');

    const res = await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 42 }));

    expect(res.status).toBe(200);
    expect(getTokenMock).toHaveBeenCalledWith('user-1');
    expect(scanPRAndCommentMock).toHaveBeenCalledWith('from-db', 'acme', 'api', 42, 'user-1');
  });

  it('passes an empty token on as it is for a user without a stored token (same call as before)', async () => {
    authMock.mockResolvedValue(SESSION);
    getTokenMock.mockResolvedValue('');

    await POST(makePostRequest({ owner: 'acme', repo: 'api', prNumber: 42 }));

    expect(scanPRAndCommentMock).toHaveBeenCalledWith('', 'acme', 'api', 42, 'user-1');
  });
});

// ---------------------------------------------------------------------------
// Per-user rate limit
// ---------------------------------------------------------------------------
describe('POST /api/pr-scan: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;
  const validBody = { owner: 'acme', repo: 'api', prNumber: 42 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    prScanRateLimiter.reset();
    authMock.mockReset();
    scanPRAndCommentMock.mockReset();
    getTokenMock.mockReset();
    getTokenMock.mockResolvedValue('tok-123');
    scanPRAndCommentMock.mockResolvedValue({ cveCount: 0 });
    authMock.mockResolvedValue(SESSION);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('budgets 120 calls per user and hour, the per-user budget of PR webhook deliveries', () => {
    expect(PR_SCAN_LIMIT_PER_HOUR).toBe(120);
  });

  it('answers 429 with Retry-After once the user is over the limit, without scanning', async () => {
    for (let i = 0; i < PR_SCAN_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest(validBody))).status).toBe(200);
    }
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(PR_SCAN_LIMIT_PER_HOUR);

    const res = await POST(makePostRequest(validBody));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(PR_SCAN_LIMIT_PER_HOUR);
  });

  it('limits per user and does not count an unauthenticated request', async () => {
    authMock.mockResolvedValue(null);
    for (let i = 0; i < PR_SCAN_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest(validBody))).status).toBe(401);
    }

    authMock.mockResolvedValue(SESSION);
    for (let i = 0; i < PR_SCAN_LIMIT_PER_HOUR; i++) await POST(makePostRequest(validBody));
    expect((await POST(makePostRequest(validBody))).status).toBe(429);

    authMock.mockResolvedValue({ user: { id: 'someone-else' } });
    expect((await POST(makePostRequest(validBody))).status).toBe(200);
  });
});
