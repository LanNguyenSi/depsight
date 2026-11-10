import { beforeEach, describe, expect, it, vi } from 'vitest';

// The session callback's return value is what GET /api/auth/session sends to
// the browser. NextAuth is stubbed to hand the config back so the callback can
// be called directly; Prisma is stubbed at the module boundary.

const { userFindUnique, nextAuthMock } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  nextAuthMock: vi.fn(),
}));

vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    nextAuthMock(config);
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  },
}));
vi.mock('next-auth/providers/github', () => ({ default: () => ({ id: 'github' }) }));
vi.mock('next-auth/providers/credentials', () => ({ default: () => ({ id: 'dev-login' }) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: userFindUnique } } }));

type SessionCallback = (args: {
  session: { user: Record<string, unknown>; expires: string };
  token: Record<string, unknown>;
}) => Promise<{ user: Record<string, unknown> }>;

async function loadSessionCallback(): Promise<SessionCallback> {
  vi.resetModules();
  nextAuthMock.mockReset();
  await import('@/lib/auth');
  const config = nextAuthMock.mock.calls[0][0] as { callbacks: { session: SessionCallback } };
  return config.callbacks.session;
}

describe('NextAuth session callback', () => {
  beforeEach(() => {
    userFindUnique.mockReset();
  });

  it('puts the user id and login into the session and no GitHub token or other token field', async () => {
    userFindUnique.mockResolvedValue({
      id: 'user-1',
      githubLogin: 'octocat',
      githubToken: 'gho_secret_oauth_token',
    });
    const session = await loadSessionCallback();

    const result = await session({
      session: { user: { name: 'Octo', email: 'o@example.com' }, expires: '2099-01-01' },
      token: { sub: 'gh-1', accessToken: 'gho_secret_oauth_token' },
    });

    expect(result.user.id).toBe('user-1');
    expect(result.user.githubLogin).toBe('octocat');
    expect(JSON.stringify(result)).not.toContain('gho_secret_oauth_token');
    expect(Object.keys(result.user).filter((k) => /token/i.test(k))).toEqual([]);
  });

  it('does not select the token column when it loads the user for the session', async () => {
    userFindUnique.mockResolvedValue({ id: 'user-1', githubLogin: 'octocat' });
    const session = await loadSessionCallback();

    await session({
      session: { user: {}, expires: '2099-01-01' },
      token: { sub: 'gh-1' },
    });

    expect(userFindUnique).toHaveBeenCalledWith({
      where: { githubId: 'gh-1' },
      select: { id: true, githubLogin: true },
    });
  });
});
