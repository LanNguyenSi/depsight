// Route-level tests for GET /api/dependabot/check.
// Uses auth() (PATTERN B). createGitHubClient is mocked to control
// which repos appear as vulnerable-alerts-disabled.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, repoFindMany, octokitRequestMock, createGitHubClientMock } = vi.hoisted(() => {
  const octokitRequestMock = vi.fn();
  const createGitHubClientMock = vi.fn(() => ({ request: octokitRequestMock }));
  return {
    authMock: vi.fn(),
    repoFindMany: vi.fn(),
    octokitRequestMock,
    createGitHubClientMock,
  };
});

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
vi.mock('@/lib/github', () => ({
  createGitHubClient: createGitHubClientMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/dependabot/check/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION = { user: { id: 'user-1', githubToken: 'tok-123' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/dependabot/check', () => {
  beforeEach(() => {
    authMock.mockReset();
    repoFindMany.mockReset();
    octokitRequestMock.mockReset();
    createGitHubClientMock.mockReset();
    // Restore factory so each test gets fresh octokit
    createGitHubClientMock.mockImplementation(() => ({ request: octokitRequestMock }));
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(repoFindMany).not.toHaveBeenCalled();
  });

  it('(2) empty repos list → 200 {total:0, disabledCount:0, disabled:[]}', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; disabledCount: number; disabled: unknown[] };
    expect(body.total).toBe(0);
    expect(body.disabledCount).toBe(0);
    expect(body.disabled).toEqual([]);
  });

  it('(3) repos where request succeeds → not in disabled list', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'repo-1', owner: 'acme', name: 'api', fullName: 'acme/api' },
      { id: 'repo-2', owner: 'acme', name: 'web', fullName: 'acme/web' },
    ]);
    // All requests succeed (vulnerability-alerts enabled)
    octokitRequestMock.mockResolvedValue({ status: 204 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; disabledCount: number; disabled: unknown[] };
    expect(body.total).toBe(2);
    expect(body.disabledCount).toBe(0);
    expect(body.disabled).toEqual([]);
  });

  it('(4) repos where request throws → appear in disabled list with exact shape', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'repo-1', owner: 'acme', name: 'api', fullName: 'acme/api' },
      { id: 'repo-2', owner: 'acme', name: 'web', fullName: 'acme/web' },
    ]);
    // First succeeds (enabled), second throws (disabled)
    octokitRequestMock
      .mockResolvedValueOnce({ status: 204 })
      .mockRejectedValueOnce(new Error('Not Found'));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as {
      total: number;
      disabledCount: number;
      disabled: Array<{ repoId: string; fullName: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.disabledCount).toBe(1);
    expect(body.disabled).toHaveLength(1);
    expect(body.disabled[0]).toEqual({ repoId: 'repo-2', fullName: 'acme/web' });
  });

  it('(5) all repos disabled → disabledCount equals total', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'r1', owner: 'org', name: 'a', fullName: 'org/a' },
      { id: 'r2', owner: 'org', name: 'b', fullName: 'org/b' },
    ]);
    octokitRequestMock.mockRejectedValue(new Error('Not Found'));

    const res = await GET();

    const body = await res.json() as { total: number; disabledCount: number; disabled: unknown[] };
    expect(body.total).toBe(2);
    expect(body.disabledCount).toBe(2);
    expect(body.disabled).toHaveLength(2);
  });

  it('(6) createGitHubClient is called with the session token', async () => {
    authMock.mockResolvedValue(SESSION);
    repoFindMany.mockResolvedValue([
      { id: 'r1', owner: 'org', name: 'a', fullName: 'org/a' },
    ]);
    octokitRequestMock.mockResolvedValue({ status: 204 });

    await GET();

    expect(createGitHubClientMock).toHaveBeenCalledWith('tok-123');
  });
});
