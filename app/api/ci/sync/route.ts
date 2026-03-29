import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { syncRepoById, syncAllUserRepos } from '@/lib/ci/sync';

export const dynamic = 'force-dynamic';

// POST /api/ci/sync
// Body: { repoId?: string } — if omitted, syncs all tracked repos for the user
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { repoId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  if (body.repoId) {
    // Verify the repo belongs to this user
    const repo = await prisma.repo.findFirst({
      where: { id: body.repoId, userId: session.user.id },
      select: { id: true },
    });
    if (!repo) {
      return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
    }

    try {
      const result = await syncRepoById(body.repoId, { daysBack: 30 });
      return NextResponse.json({ result });
    } catch (err) {
      console.error('[ci/sync] Error syncing repo:', err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Sync failed' },
        { status: 500 }
      );
    }
  } else {
    // Sync all tracked repos for this user
    const summary = await syncAllUserRepos(session.user.id, { daysBack: 30 });
    return NextResponse.json({ summary });
  }
}
