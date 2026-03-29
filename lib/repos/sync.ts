import type { Prisma } from '@prisma/client';

export interface GitHubRepoSyncRecord {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  owner: {
    login: string;
  };
}

interface RepoTransactionClient {
  repo: {
    findMany(args: {
      where: { userId: string; tracked: boolean };
      select: { githubId: boolean };
    }): Promise<Array<{ githubId: number }>>;
    upsert(args: {
      where: { userId_githubId: { userId: string; githubId: number } };
      update: {
        name: string;
        fullName: string;
        owner: string;
        private: boolean;
        defaultBranch: string;
        language: string | null;
        tracked: boolean;
      };
      create: {
        userId: string;
        githubId: number;
        name: string;
        fullName: string;
        owner: string;
        private: boolean;
        defaultBranch: string;
        language: string | null;
        tracked: boolean;
      };
    }): Prisma.PrismaPromise<unknown>;
    updateMany(args: {
      where: { userId: string; githubId: { in: number[] }; tracked: boolean };
      data: { tracked: boolean };
    }): Prisma.PrismaPromise<unknown>;
  };
  $transaction(operations: Prisma.PrismaPromise<unknown>[]): Promise<unknown>;
}

export function getRemovedGithubRepoIds(
  existingTrackedRepoGithubIds: number[],
  githubRepos: GitHubRepoSyncRecord[],
) {
  const syncedRepoIds = new Set(githubRepos.map((repo) => repo.id));
  return existingTrackedRepoGithubIds.filter((repoId) => !syncedRepoIds.has(repoId));
}

export async function syncUserRepos(
  db: RepoTransactionClient,
  userId: string,
  githubRepos: GitHubRepoSyncRecord[],
) {
  const existingTrackedRepos = await db.repo.findMany({
    where: { userId, tracked: true },
    select: { githubId: true },
  });

  const removedRepoIds = getRemovedGithubRepoIds(
    existingTrackedRepos.map((repo) => repo.githubId),
    githubRepos,
  );

  const operations: Prisma.PrismaPromise<unknown>[] = githubRepos.map((repo) =>
    db.repo.upsert({
      where: {
        userId_githubId: {
          userId,
          githubId: repo.id,
        },
      },
      update: {
        name: repo.name,
        fullName: repo.fullName,
        owner: repo.owner.login,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        language: repo.language,
        tracked: true,
      },
      create: {
        userId,
        githubId: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        owner: repo.owner.login,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        language: repo.language,
        tracked: true,
      },
    }),
  );

  if (removedRepoIds.length > 0) {
    operations.push(
      db.repo.updateMany({
        where: {
          userId,
          githubId: { in: removedRepoIds },
          tracked: true,
        },
        data: { tracked: false },
      }),
    );
  }

  if (operations.length > 0) {
    await db.$transaction(operations);
  }

  return {
    syncedCount: githubRepos.length,
    removedCount: removedRepoIds.length,
  };
}
