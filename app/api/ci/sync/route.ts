import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser, hasWriteScope } from '@/lib/auth-api';
import { prisma } from '@/lib/prisma';
import { syncRepoById, syncAllUserRepos } from '@/lib/ci/sync';

export const dynamic = 'force-dynamic';

// POST /api/ci/sync
// Body: { repoId?: string } — if omitted, syncs all tracked repos for the user.
// Reachable with a dsat_ Bearer token or a browser login. The sync persists
// workflow runs and spends the owner's GitHub API quota, so it requires the
// WRITE scope (a READ-scoped token gets 403), like POST /api/scan.
export async function POST(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
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
      where: { id: body.repoId, userId: user.id },
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
    const summary = await syncAllUserRepos(user.id, { daysBack: 30 });
    return NextResponse.json({ summary });
  }
}
