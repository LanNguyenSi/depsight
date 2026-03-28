import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enableDependabotAlerts } from '@/lib/cve/github-advisories';

export const dynamic = 'force-dynamic';

// POST /api/dependabot — enable Dependabot alerts for a repo
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as { repoId?: string };
  const { repoId } = body;

  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required' }, { status: 400 });
  }

  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId: session.user.id },
  });

  if (!repo) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  const success = await enableDependabotAlerts(
    session.user.githubToken,
    repo.owner,
    repo.name,
  );

  if (!success) {
    return NextResponse.json(
      { error: 'Failed to enable Dependabot. You may need admin access to this repository.' },
      { status: 403 },
    );
  }

  return NextResponse.json({ success: true });
}
