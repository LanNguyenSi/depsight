import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getUserRepos } from '@/lib/github';

export const dynamic = 'force-dynamic';

// POST /api/repos/sync — sync GitHub repos into DB for current user
export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const githubRepos = await getUserRepos(session.user.githubToken);

    // Upsert all repos in a transaction
    await prisma.$transaction(
      githubRepos.map((repo) =>
        prisma.repo.upsert({
          where: {
            userId_githubId: {
              userId: session.user.id,
              githubId: repo.id,
            },
          },
          update: {
            name: repo.name,
            fullName: repo.fullName,
            owner: repo.owner.login,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            language: repo.language ?? null,
            updatedAt: new Date(),
          },
          create: {
            userId: session.user.id,
            githubId: repo.id,
            name: repo.name,
            fullName: repo.fullName,
            owner: repo.owner.login,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            language: repo.language ?? null,
          },
        }),
      ),
    );

    return NextResponse.json({ synced: githubRepos.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
