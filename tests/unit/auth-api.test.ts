import { describe, it, expect, vi, beforeEach } from 'vitest';

// `auth-api.ts` bridges three external concerns (NextAuth session,
// `headers()` from next/headers, and Prisma). This test stubs all
// three at the module boundary so we can cover each branch of
// `resolveRequestUser` without spinning up Next.js or the DB.

const { authMock, headersMock, apiTokenFindUnique, apiTokenUpdate } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    headersMock: vi.fn(),
    apiTokenFindUnique: vi.fn(),
    apiTokenUpdate: vi.fn().mockResolvedValue({}),
  }));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiToken: {
      findUnique: apiTokenFindUnique,
      update: apiTokenUpdate,
    },
  },
}));

import { resolveRequestUser } from '@/lib/auth-api';

function buildHeaders(map: Record<string, string>) {
  return {
    get: (k: string) => map[k.toLowerCase()] ?? null,
  };
}

describe('resolveRequestUser', () => {
  beforeEach(() => {
    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUnique.mockReset();
    apiTokenUpdate.mockReset();
    apiTokenUpdate.mockResolvedValue({});
  });

  it('returns the user when an active NextAuth session exists (session wins)', async () => {
    authMock.mockResolvedValue({
      user: {
        id: 'user-1',
        githubLogin: 'octocat',
        githubToken: 'gh_session_token',
      },
    });
    headersMock.mockResolvedValue(buildHeaders({}));

    const result = await resolveRequestUser();
    expect(result).toEqual({
      id: 'user-1',
      githubLogin: 'octocat',
      githubToken: 'gh_session_token',
    });
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('falls back to the Bearer dsat_ token when no session is present', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_valid_token' }),
    );
    apiTokenFindUnique.mockResolvedValue({
      id: 'tok-1',
      revokedAt: null,
      user: {
        id: 'user-2',
        githubLogin: 'agent',
        githubToken: 'gh_token_agent',
      },
    });

    const result = await resolveRequestUser();
    expect(result).toEqual({
      id: 'user-2',
      githubLogin: 'agent',
      githubToken: 'gh_token_agent',
    });
    expect(apiTokenFindUnique).toHaveBeenCalledWith({
      where: { token: 'dsat_valid_token' },
      include: {
        user: {
          select: { id: true, githubLogin: true, githubToken: true },
        },
      },
    });
    // lastUsedAt is stamped fire-and-forget
    expect(apiTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tok-1' },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      }),
    );
  });

  it('returns null when the bearer token is not dsat_ prefixed', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer some_other_token' }),
    );

    const result = await resolveRequestUser();
    expect(result).toBeNull();
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('returns null when there is no Authorization header', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({}));

    const result = await resolveRequestUser();
    expect(result).toBeNull();
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('returns null when the token row is revoked', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_revoked' }),
    );
    apiTokenFindUnique.mockResolvedValue({
      id: 'tok-x',
      revokedAt: new Date('2026-01-01T00:00:00Z'),
      user: { id: 'user-x', githubLogin: null, githubToken: '' },
    });

    const result = await resolveRequestUser();
    expect(result).toBeNull();
    // We must NOT stamp lastUsedAt on revoked tokens — keeps audit honest.
    expect(apiTokenUpdate).not.toHaveBeenCalled();
  });

  it('returns null when the token does not exist in the DB', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_unknown' }),
    );
    apiTokenFindUnique.mockResolvedValue(null);

    const result = await resolveRequestUser();
    expect(result).toBeNull();
    expect(apiTokenUpdate).not.toHaveBeenCalled();
  });
});
