import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createGitHubClient } from '@/lib/github';
import { getSessionGitHubToken } from '@/lib/auth-api';
import { dependabotCheckRateLimiter, rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// GET /api/dependabot/check — check which repos have dependabot disabled
// Rate limited per user, keyed by user id, like the all-repos CI sync (see
// lib/rate-limit.ts): this route calls GitHub once per tracked repo, so a
// looping caller is capped and over the limit the answer is 429 with
// Retry-After and no database or GitHub work is started.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = dependabotCheckRateLimiter.check(session.user.id);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
  }

  const repos = await prisma.repo.findMany({
    where: { userId: session.user.id, tracked: true },
    select: { id: true, owner: true, name: true, fullName: true },
  });

  const octokit = createGitHubClient(await getSessionGitHubToken(session.user.id));
  const disabled: Array<{ repoId: string; fullName: string }> = [];

  // Check in parallel (batches of 10 to respect rate limits)
  const BATCH = 10;
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (repo) => {
        try {
          // 204 = enabled, 404 = disabled
          await octokit.request('GET /repos/{owner}/{repo}/vulnerability-alerts', {
            owner: repo.owner,
            repo: repo.name,
          });
        } catch {
          disabled.push({ repoId: repo.id, fullName: repo.fullName });
        }
      }),
    );
  }

  return NextResponse.json({
    total: repos.length,
    disabledCount: disabled.length,
    disabled,
  });
}
