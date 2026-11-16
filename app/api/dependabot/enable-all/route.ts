import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enableDependabotAlerts } from '@/lib/cve/github-advisories';
import { getSessionGitHubToken } from '@/lib/auth-api';
import { readJsonCapped, ID_LIST_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';

export const dynamic = 'force-dynamic';

// POST /api/dependabot/enable-all — enable Dependabot for multiple repos
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = await readJsonCapped<{ repoIds?: string[] }>(req, ID_LIST_JSON_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const { repoIds } = body;

  if (!repoIds || repoIds.length === 0) {
    return NextResponse.json({ error: 'repoIds is required' }, { status: 400 });
  }

  const repos = await prisma.repo.findMany({
    where: { id: { in: repoIds }, userId: session.user.id, tracked: true },
    select: { id: true, owner: true, name: true },
  });

  const githubToken = await getSessionGitHubToken(session.user.id);
  let enabled = 0;
  let failed = 0;

  for (const repo of repos) {
    const ok = await enableDependabotAlerts(githubToken, repo.owner, repo.name);
    if (ok) enabled++;
    else failed++;
  }

  return NextResponse.json({ enabled, failed });
}
