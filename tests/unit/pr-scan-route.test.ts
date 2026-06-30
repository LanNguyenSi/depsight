// Route-level tests for POST /api/pr-scan.
// Uses auth() (PATTERN B).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, scanPRAndCommentMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  scanPRAndCommentMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/pr/pr-scanner', () => ({
  scanPRAndComment: scanPRAndCommentMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/pr-scan/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

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
    authMock.mockReset();
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
