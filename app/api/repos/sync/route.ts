import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getUserRepos } from '@/lib/github';
import { syncUserRepos } from '@/lib/repos/sync';
import { getSessionGitHubToken } from '@/lib/auth-api';
import { reposRateLimiter, rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/repos/sync — sync GitHub repos into DB for current user
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = reposRateLimiter.check(session.user.id);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
  }

  try {
    const githubRepos = await getUserRepos(await getSessionGitHubToken(session.user.id));
    const result = await syncUserRepos(prisma, session.user.id, githubRepos);
    return NextResponse.json({
      synced: result.syncedCount,
      removed: result.removedCount,
      archived: result.archivedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
