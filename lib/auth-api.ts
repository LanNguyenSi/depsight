import { headers } from 'next/headers';
import { auth } from './auth';
import { prisma } from './prisma';
import type { ApiTokenScope } from '@prisma/client';
import { API_TOKEN_PREFIX, hashApiToken } from './api-token';

export interface ResolvedUser {
  id: string;
  githubLogin: string | null;
  githubToken: string;
  // WRITE grants both read and write; READ is a dsat_ token restricted to
  // read-only routes. A browser session user always resolves to WRITE
  // (unaffected by this field, same as before it existed).
  scope: ApiTokenScope;
}

/** True when the resolved user's scope allows write operations (WRITE). */
export function hasWriteScope(user: ResolvedUser): boolean {
  return user.scope === 'WRITE';
}

/**
 * The GitHub OAuth access token of a session user, read from the `User` row
 * (written at every GitHub sign-in in lib/auth.ts). It is deliberately not part
 * of the session object, which the browser receives from /api/auth/session.
 * Returns '' when the user row is gone or holds no token; callers treat that
 * like any other empty token. Server-side only.
 */
export async function getSessionGitHubToken(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { githubToken: true },
  });
  return row?.githubToken ?? '';
}

/**
 * Resolve the acting user for an API route. Tries the NextAuth session
 * first (browser users), then falls back to a Bearer `dsat_` API token
 * (`Authorization: Bearer dsat_...`) for headless agents like the MCP
 * server.
 *
 * `dsat_` stands for "Depsight API Token". Tokens live in the
 * `ApiToken` Prisma model, stored as a SHA-256 hash (lib/api-token.ts); a
 * revoked token (revokedAt set) will not resolve to a user.
 *
 * Returns null if neither path yields an active user.
 */
export async function resolveRequestUser(): Promise<ResolvedUser | null> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      id: session.user.id,
      githubLogin: session.user.githubLogin ?? null,
      // Dev Login users carry the placeholder token "dev-token" (lib/auth.ts),
      // which GitHub rejects; callers that need GitHub access must handle that.
      githubToken: await getSessionGitHubToken(session.user.id),
      // A logged-in browser user always has full access, same as before
      // ApiToken.scope existed.
      scope: 'WRITE',
    };
  }

  const headerList = await headers();
  const authHeader = headerList.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const rawToken = authHeader.slice('Bearer '.length).trim();
  if (!rawToken || !rawToken.startsWith(API_TOKEN_PREFIX)) return null;

  // `ApiToken.token` holds the SHA-256 of the token, never the token itself,
  // so the presented value is hashed before the lookup.
  const record = await prisma.apiToken.findUnique({
    where: { token: hashApiToken(rawToken) },
    include: {
      user: {
        select: { id: true, githubLogin: true, githubToken: true },
      },
    },
  });
  if (!record || record.revokedAt) return null;

  // Fire-and-forget: stamp lastUsedAt so operators can see which
  // tokens are actually in use. Failure must not block the request.
  void prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[auth-api] Failed to stamp lastUsedAt:', message);
    });

  return {
    id: record.user.id,
    githubLogin: record.user.githubLogin,
    githubToken: record.user.githubToken,
    scope: record.scope,
  };
}
