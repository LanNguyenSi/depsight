import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createGitHubClient } from '@/lib/github';

export const dynamic = 'force-dynamic';

// GET /api/dependabot/check — check which repos have dependabot disabled
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const repos = await prisma.repo.findMany({
    where: { userId: session.user.id, tracked: true },
    select: { id: true, owner: true, name: true, fullName: true },
  });

  const octokit = createGitHubClient(session.user.githubToken);
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
