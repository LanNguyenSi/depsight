// Route-level tests for GET /api/me.
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import route last.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, userFindUnique } = vi.hoisted(() => ({
  authMock: vi.fn(),
  userFindUnique: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/me/route';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/me', () => {
  beforeEach(() => {
    authMock.mockReset();
    userFindUnique.mockReset();
  });

  it('(1) returns 401 when auth returns no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('(2) returns 401 when session has no user.id', async () => {
    authMock.mockResolvedValue({ user: {} });

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('(3) returns 404 when user is not found in DB', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    userFindUnique.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { githubLogin: true, avatarUrl: true },
    });
  });

  it('(4) returns 200 with githubLogin and avatarUrl for a valid session', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-42' } });
    userFindUnique.mockResolvedValue({ githubLogin: 'lan', avatarUrl: 'https://avatars.githubusercontent.com/u/42' });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { githubLogin: string; avatarUrl: string };
    expect(body.githubLogin).toBe('lan');
    expect(body.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42');
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-42' },
      select: { githubLogin: true, avatarUrl: true },
    });
  });

  it('(5) returns 200 with null avatarUrl when user has no avatar', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-99' } });
    userFindUnique.mockResolvedValue({ githubLogin: 'noavatar', avatarUrl: null });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { githubLogin: string; avatarUrl: null };
    expect(body.githubLogin).toBe('noavatar');
    expect(body.avatarUrl).toBeNull();
  });
});
