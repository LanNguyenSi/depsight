// Route-level tests for POST /api/dependabot/enable-all.
// Uses auth() (PATTERN B).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, repoFindMany, enableDependabotAlertsMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  repoFindMany: vi.fn(),
  enableDependabotAlertsMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findMany: repoFindMany,
    },
  },
}));
vi.mock('@/lib/cve/github-advisories', () => ({
  enableDependabotAlerts: enableDependabotAlertsMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/dependabot/enable-all/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/dependabot/enable-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/dependabot/enable-all', () => {
  beforeEach(() => {
    authMock.mockReset();
    repoFindMany.mockReset();
    enableDependabotAlertsMock.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ repoIds: ['r1'] }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(repoFindMany).not.toHaveBeenCalled();
  });

  it('(2) returns 400 when repoIds is missing', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoIds is required');
    expect(repoFindMany).not.toHaveBeenCalled();
  });

  it('(3) returns 400 when repoIds is an empty array', async () => {
    authMock.mockResolvedValue(SESSION);

    const res = await POST(makePostRequest({ repoIds: [] }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoIds is required');
    expect(repoFindMany).not.toHaveBeenCalled();
  });

  it('(4) returns 200 {enabled,failed} on happy path — asserts exact findMany where clause', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'r1', owner: 'acme', name: 'api' },
      { id: 'r2', owner: 'acme', name: 'web' },
    ]);
    enableDependabotAlertsMock.mockResolvedValue(true);

    const res = await POST(makePostRequest({ repoIds: ['r1', 'r2'] }));

    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: number; failed: number };
    expect(body.enabled).toBe(2);
    expect(body.failed).toBe(0);
    expect(repoFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] }, userId: 'user-1', tracked: true },
      select: { id: true, owner: true, name: true },
    });
  });

  it('(4b) scopes the findMany where clause to tracked: true, so an untracked repo id is silently skipped', async () => {
    authMock.mockResolvedValue(SESSION);
    // Simulate Prisma's `tracked: true` filter excluding an untracked repo:
    // the mock only returns the repos that would actually match the where
    // clause, so this fails if the route stops passing `tracked: true`.
    repoFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] }; userId: string; tracked?: boolean } }) => {
      const allRepos = [
        { id: 'r1', owner: 'acme', name: 'api', tracked: true },
        { id: 'r2', owner: 'acme', name: 'archived-repo', tracked: false },
      ];
      return allRepos.filter(
        (r) =>
          where.id.in.includes(r.id) &&
          (where.tracked === undefined || r.tracked === where.tracked),
      );
    });
    enableDependabotAlertsMock.mockResolvedValue(true);

    const res = await POST(makePostRequest({ repoIds: ['r1', 'r2'] }));

    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: number; failed: number };
    // Only r1 (tracked) is processed; r2 (untracked) never reaches enableDependabotAlerts.
    expect(body.enabled).toBe(1);
    expect(body.failed).toBe(0);
    expect(enableDependabotAlertsMock).toHaveBeenCalledTimes(1);
    expect(enableDependabotAlertsMock).toHaveBeenCalledWith('tok-123', 'acme', 'api');
  });

  it('(5) returns 200 with correct failed count when enableDependabotAlerts returns false', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'r1', owner: 'acme', name: 'api' },
      { id: 'r2', owner: 'acme', name: 'web' },
    ]);
    // First succeeds, second fails
    enableDependabotAlertsMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const res = await POST(makePostRequest({ repoIds: ['r1', 'r2'] }));

    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: number; failed: number };
    expect(body.enabled).toBe(1);
    expect(body.failed).toBe(1);
  });

  it('(6) returns 200 with all failed when all repos fail — still 200, not 4xx/5xx', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'r1', owner: 'acme', name: 'api' },
    ]);
    enableDependabotAlertsMock.mockResolvedValue(false);

    const res = await POST(makePostRequest({ repoIds: ['r1'] }));

    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: number; failed: number };
    expect(body.enabled).toBe(0);
    expect(body.failed).toBe(1);
  });

  it('(7) passes the session github token to enableDependabotAlerts', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'r1', owner: 'org', name: 'myrepo' },
    ]);
    enableDependabotAlertsMock.mockResolvedValue(true);

    await POST(makePostRequest({ repoIds: ['r1'] }));

    expect(enableDependabotAlertsMock).toHaveBeenCalledWith('tok-123', 'org', 'myrepo');
  });
});
