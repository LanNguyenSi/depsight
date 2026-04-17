import { headers } from 'next/headers';
import { auth } from './auth';
import { prisma } from './prisma';

export interface ResolvedUser {
  id: string;
  githubLogin: string | null;
  githubToken: string;
}

/**
 * Resolve the acting user for an API route. Tries the NextAuth session
 * first (browser users), then falls back to a Bearer `dsat_` API token
 * (`Authorization: Bearer dsat_...`) for headless agents like the MCP
 * server.
 *
 * `dsat_` stands for "Depsight API Token". Tokens live in the
 * `ApiToken` Prisma model; a revoked token (revokedAt set) will not
 * resolve to a user.
 *
 * Returns null if neither path yields an active user.
 */
export async function resolveRequestUser(): Promise<ResolvedUser | null> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      id: session.user.id,
      githubLogin: session.user.githubLogin ?? null,
      // githubToken may be "" for dev-login; callers that need GitHub
      // access must handle that.
      githubToken: session.user.githubToken ?? '',
    };
  }

  const headerList = await headers();
  const authHeader = headerList.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const rawToken = authHeader.slice('Bearer '.length).trim();
  if (!rawToken || !rawToken.startsWith('dsat_')) return null;

  const record = await prisma.apiToken.findUnique({
    where: { token: rawToken },
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
  };
}
