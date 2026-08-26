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

import { resolveRequestUser, hasWriteScope, type ResolvedUser } from '@/lib/auth-api';

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
      // A browser session always resolves to full access, regardless of
      // ApiToken.scope (which only applies to Bearer dsat_ tokens).
      scope: 'WRITE',
    });
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('falls back to the Bearer dsat_ token when no session is present, and carries its READ scope', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_valid_token' }),
    );
    apiTokenFindUnique.mockResolvedValue({
      id: 'tok-1',
      revokedAt: null,
      scope: 'READ',
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
      scope: 'READ',
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

  it('carries a WRITE-scoped dsat_ token through as scope WRITE', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_full_access' }),
    );
    apiTokenFindUnique.mockResolvedValue({
      id: 'tok-2',
      revokedAt: null,
      scope: 'WRITE',
      user: {
        id: 'user-3',
        githubLogin: 'agent2',
        githubToken: 'gh_token_agent2',
      },
    });

    const result = await resolveRequestUser();
    expect(result).toEqual({
      id: 'user-3',
      githubLogin: 'agent2',
      githubToken: 'gh_token_agent2',
      scope: 'WRITE',
    });
  });

  // Pins that resolveRequestUser forwards record.scope exactly as-is: a
  // token row with no scope value at all (undefined) resolves to scope
  // undefined, NOT a defaulted 'WRITE'. Combined with hasWriteScope's own
  // fail-closed test above, this proves the "existing tokens keep write
  // access" guarantee lives only in the schema's @default(WRITE) applied by
  // `prisma db push`, never in a defensive fallback here that could mask a
  // migration that failed to backfill it.
  it('does not default a missing scope to WRITE (forwards undefined, fails closed downstream)', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_no_scope' }),
    );
    apiTokenFindUnique.mockResolvedValue({
      id: 'tok-3',
      revokedAt: null,
      scope: undefined,
      user: {
        id: 'user-4',
        githubLogin: 'agent3',
        githubToken: 'gh_token_agent3',
      },
    });

    const result = await resolveRequestUser();
    expect(result).toEqual({
      id: 'user-4',
      githubLogin: 'agent3',
      githubToken: 'gh_token_agent3',
      scope: undefined,
    });
    expect(result && hasWriteScope(result)).toBe(false);
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

describe('hasWriteScope', () => {
  const baseUser: ResolvedUser = {
    id: 'user-1',
    githubLogin: 'octocat',
    githubToken: 'gh_tok',
    scope: 'WRITE',
  };

  it('returns true for a WRITE-scoped user', () => {
    expect(hasWriteScope({ ...baseUser, scope: 'WRITE' })).toBe(true);
  });

  it('returns false for a READ-scoped user', () => {
    expect(hasWriteScope({ ...baseUser, scope: 'READ' })).toBe(false);
  });

  // Pins fail-closed behaviour: a record with no scope value at all (e.g. a
  // row the schema default somehow did not reach) must NOT be treated as
  // WRITE. There is no `?? 'WRITE'` fallback anywhere in this predicate or
  // in resolveRequestUser() (see the resolveRequestUser test below); adding
  // one later would silently reopen full access for exactly the rows this
  // task's default is meant to protect.
  it('returns false (fails closed) for a user with an undefined scope, not WRITE', () => {
    const noScopeUser = { ...baseUser, scope: undefined as unknown as ResolvedUser['scope'] };
    expect(hasWriteScope(noScopeUser)).toBe(false);
  });
});
