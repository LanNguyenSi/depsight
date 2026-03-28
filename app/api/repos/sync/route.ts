import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getUserRepos } from '@/lib/github';
import { syncUserRepos } from '@/lib/repos/sync';

export const dynamic = 'force-dynamic';

// POST /api/repos/sync — sync GitHub repos into DB for current user
export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const githubRepos = await getUserRepos(session.user.githubToken);
    const result = await syncUserRepos(prisma, session.user.id, githubRepos);
    return NextResponse.json({ synced: result.syncedCount, removed: result.removedCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
