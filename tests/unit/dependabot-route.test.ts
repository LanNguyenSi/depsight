// Route-level tests for POST /api/dependabot.
// Uses auth() (PATTERN B).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, repoFindFirst, enableDependabotAlertsMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  repoFindFirst: vi.fn(),
  enableDependabotAlertsMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE any imports that resolve the real modules
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findFirst: repoFindFirst,
    },
  },
}));
vi.mock('@/lib/cve/github-advisories', () => ({
  enableDependabotAlerts: enableDependabotAlertsMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/dependabot/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/dependabot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/dependabot', () => {
  beforeEach(() => {
    authMock.mockReset();
    repoFindFirst.mockReset();
    enableDependabotAlertsMock.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(repoFindFirst).not.toHaveBeenCalled();
  });

  it('(2) returns 400 when repoId is missing', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
    expect(repoFindFirst).not.toHaveBeenCalled();
  });

  it('(3) returns 404 when repo is not found/not owned/not tracked — asserts exact where clause', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindFirst.mockResolvedValue(null);

    const res = await POST(makePostRequest({ repoId: 'repo-999' }));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Repository not found');
    expect(repoFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-999', userId: 'user-1', tracked: true },
    });
    expect(enableDependabotAlertsMock).not.toHaveBeenCalled();
  });

  it('(4) returns 403 when enableDependabotAlerts returns false (insufficient admin access)', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindFirst.mockResolvedValue({ id: 'repo-1', owner: 'acme', name: 'my-app' });
    enableDependabotAlertsMock.mockResolvedValue(false);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Failed to enable Dependabot');
    expect(enableDependabotAlertsMock).toHaveBeenCalledWith('tok-123', 'acme', 'my-app');
  });

  it('(5) returns 200 {success:true} when enableDependabotAlerts succeeds', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindFirst.mockResolvedValue({ id: 'repo-1', owner: 'acme', name: 'my-app' });
    enableDependabotAlertsMock.mockResolvedValue(true);

    const res = await POST(makePostRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(enableDependabotAlertsMock).toHaveBeenCalledWith('tok-123', 'acme', 'my-app');
  });
});
