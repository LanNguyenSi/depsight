import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enableDependabotAlerts } from '@/lib/cve/github-advisories';

export const dynamic = 'force-dynamic';

// POST /api/dependabot/enable-all — enable Dependabot for multiple repos
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json()) as { repoIds?: string[] };
  const { repoIds } = body;

  if (!repoIds || repoIds.length === 0) {
    return NextResponse.json({ error: 'repoIds is required' }, { status: 400 });
  }

  const repos = await prisma.repo.findMany({
    where: { id: { in: repoIds }, userId: session.user.id },
    select: { id: true, owner: true, name: true },
  });

  let enabled = 0;
  let failed = 0;

  for (const repo of repos) {
    const ok = await enableDependabotAlerts(session.user.githubToken, repo.owner, repo.name);
    if (ok) enabled++;
    else failed++;
  }

  return NextResponse.json({ enabled, failed });
}
