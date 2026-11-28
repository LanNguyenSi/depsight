import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enableDependabotAlerts } from '@/lib/cve/github-advisories';
import { getSessionGitHubToken } from '@/lib/auth-api';
import { readJsonCapped, ID_LIST_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';
import { dependabotEnableAllRateLimiter, rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/dependabot/enable-all — enable Dependabot for multiple repos
// Rate limited per user, keyed by user id, like the all-repos CI sync (see
// lib/rate-limit.ts): one GitHub write per given tracked repo, so a looping
// caller is capped and over the limit the answer is 429 with Retry-After,
// before the body is read and before any database or GitHub work.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = dependabotEnableAllRateLimiter.check(session.user.id);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
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
