import { describe, it, expect, vi, beforeEach } from 'vitest';

// `auth-api.ts` bridges three external concerns (NextAuth session,
// `headers()` from next/headers, and Prisma). This test stubs all
// three at the module boundary so we can cover each branch of
// `resolveRequestUser` without spinning up Next.js or the DB.

const { authMock, headersMock, apiTokenFindUnique, apiTokenUpdate, userFindUnique } =
  vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    authMock: vi.fn(),
    headersMock: vi.fn(),
    apiTokenFindUnique: vi.fn(),
    apiTokenUpdate: vi.fn().mockResolvedValue({}),
  }));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    apiToken: {
      findUnique: apiTokenFindUnique,
      update: apiTokenUpdate,
    },
  },
}));

import { createHash } from 'node:crypto';
import {
  resolveRequestUser,
  getSessionGitHubToken,
  hasWriteScope,
  type ResolvedUser,
} from '@/lib/auth-api';

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

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
    userFindUnique.mockReset();
  });

  it('returns the user when an active NextAuth session exists (session wins), with the GitHub token read from the User row', async () => {
    authMock.mockResolvedValue({
      user: {
        id: 'user-1',
        githubLogin: 'octocat',
      },
    });
    userFindUnique.mockResolvedValue({ githubToken: 'gh_session_token' });
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
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { githubToken: true },
    });
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('ignores a token field on the session object and resolves an empty token for a session user without a stored token', async () => {
    authMock.mockResolvedValue({
      user: { id: 'user-1', githubLogin: 'octocat', githubToken: 'from-session' },
    });
    userFindUnique.mockResolvedValue({ githubToken: '' });
    headersMock.mockResolvedValue(buildHeaders({}));

    const result = await resolveRequestUser();

    expect(result?.githubToken).toBe('');
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
      where: { token: sha256Hex('dsat_valid_token') },
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

  // A JWT session whose user row is gone carries a token but no user id.
  // Callers filter Prisma queries by user.id, and Prisma drops an undefined
  // filter value, so such a session must never resolve to a user.
  it('returns null for a session without a user id and no Authorization header', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'x' } });
    headersMock.mockResolvedValue(buildHeaders({}));

    const result = await resolveRequestUser();

    expect(result).toBeNull();
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('falls through to a valid dsat_ Bearer token when the session has no user id, resolving the token owner', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'x' } });
    headersMock.mockResolvedValue(
      buildHeaders({ authorization: 'Bearer dsat_valid_token' }),
    );
    apiTokenFindUnique.mockResolvedValue({
      id: 'tok-owner',
      revokedAt: null,
      scope: 'READ',
      user: {
        id: 'token-owner',
        githubLogin: 'owner',
        githubToken: 'gh_token_owner',
      },
    });

    const result = await resolveRequestUser();

    expect(result).toEqual({
      id: 'token-owner',
      githubLogin: 'owner',
      githubToken: 'gh_token_owner',
      scope: 'READ',
    });
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

describe('resolveRequestUser - dsat_ tokens are matched by hash', () => {
  const RAW = 'dsat_' + 'ab12'.repeat(16);
  const STORED = createHash('sha256').update(RAW).digest('hex');
  const row = {
    id: 'tok-h',
    revokedAt: null as Date | null,
    scope: 'READ',
    user: { id: 'user-h', githubLogin: 'hashed', githubToken: 'gh_h' },
  };

  beforeEach(() => {
    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUnique.mockReset();
    apiTokenUpdate.mockReset();
    apiTokenUpdate.mockResolvedValue({});
    authMock.mockResolvedValue(null);
    // A table that holds only the hash: a lookup by anything else finds nothing.
    apiTokenFindUnique.mockImplementation(async (args: { where: { token: string } }) =>
      args.where.token === STORED ? row : null,
    );
  });

  it('resolves the owner when the raw token is presented, looking it up by its SHA-256', async () => {
    headersMock.mockResolvedValue(buildHeaders({ authorization: `Bearer ${RAW}` }));

    const result = await resolveRequestUser();

    expect(result).toMatchObject({ id: 'user-h', scope: 'READ' });
    expect(STORED).toMatch(/^[0-9a-f]{64}$/);
    expect(apiTokenFindUnique).toHaveBeenCalledTimes(1);
    expect(apiTokenFindUnique.mock.calls[0][0].where).toEqual({ token: STORED });
  });

  it('still resolves a row that holds the raw token (not yet migrated), after the hash lookup missed', async () => {
    const legacy = { ...row, id: 'tok-legacy', user: { ...row.user, id: 'user-legacy' } };
    apiTokenFindUnique.mockImplementation(async (args: { where: { token: string } }) =>
      args.where.token === RAW ? legacy : null,
    );
    headersMock.mockResolvedValue(buildHeaders({ authorization: `Bearer ${RAW}` }));

    expect(await resolveRequestUser()).toMatchObject({ id: 'user-legacy', scope: 'READ' });
    expect(apiTokenFindUnique.mock.calls.map((c) => c[0].where.token)).toEqual([STORED, RAW]);
    expect(apiTokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tok-legacy' } }),
    );
  });

  it('does not resolve a revoked raw-token row through the fallback', async () => {
    const legacy = { ...row, revokedAt: new Date('2026-01-01T00:00:00Z') };
    apiTokenFindUnique.mockImplementation(async (args: { where: { token: string } }) =>
      args.where.token === RAW ? legacy : null,
    );
    headersMock.mockResolvedValue(buildHeaders({ authorization: `Bearer ${RAW}` }));

    expect(await resolveRequestUser()).toBeNull();
  });

  it('does not resolve when the stored hash itself is presented as the bearer token', async () => {
    headersMock.mockResolvedValue(buildHeaders({ authorization: `Bearer ${STORED}` }));

    expect(await resolveRequestUser()).toBeNull();
    // Not dsat_ prefixed: rejected before any lookup.
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it('does not resolve a dsat_-prefixed value that is not the token, and hashes it before the lookup', async () => {
    headersMock.mockResolvedValue(buildHeaders({ authorization: `Bearer dsat_${STORED}` }));

    expect(await resolveRequestUser()).toBeNull();
    expect(apiTokenFindUnique.mock.calls[0][0].where.token).toBe(sha256Hex(`dsat_${STORED}`));
    // The raw-value fallback looks up `dsat_<hash>`, which no hashed row holds.
    expect(apiTokenFindUnique.mock.calls[1][0].where.token).toBe(`dsat_${STORED}`);
  });

  it('does not resolve a revoked token and does not stamp lastUsedAt', async () => {
    row.revokedAt = new Date('2026-01-01T00:00:00Z');
    headersMock.mockResolvedValue(buildHeaders({ authorization: `Bearer ${RAW}` }));

    try {
      expect(await resolveRequestUser()).toBeNull();
      expect(apiTokenUpdate).not.toHaveBeenCalled();
    } finally {
      row.revokedAt = null;
    }
  });

  it('does no database lookup for a bearer token without the dsat_ prefix', async () => {
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer ghp_something' }));

    expect(await resolveRequestUser()).toBeNull();
    expect(apiTokenFindUnique).not.toHaveBeenCalled();
  });
});

describe('getSessionGitHubToken', () => {
  beforeEach(() => {
    userFindUnique.mockReset();
  });

  it('reads the token of the given user id from the User row', async () => {
    userFindUnique.mockResolvedValue({ githubToken: 'gh_stored' });

    await expect(getSessionGitHubToken('user-7')).resolves.toBe('gh_stored');
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-7' },
      select: { githubToken: true },
    });
  });

  it('returns an empty string for a missing row and for an empty stored token', async () => {
    userFindUnique.mockResolvedValueOnce(null);
    await expect(getSessionGitHubToken('gone')).resolves.toBe('');

    userFindUnique.mockResolvedValueOnce({ githubToken: '' });
    await expect(getSessionGitHubToken('no-token')).resolves.toBe('');
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
