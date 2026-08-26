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
  // GitHub's `archived` flag. Optional and fail-safe: a repo whose archived
  // status could not be determined (field missing from the GitHub API
  // response) is treated as `false` (not archived) and stays tracked, so a
  // schema change or partial API response never silently untracks a repo.
  archived?: boolean;
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

// Splits a GitHub repo list into repos to keep syncing (not archived, or
// archived-status unknown, fail-safe default) and repos GitHub reports as
// archived. Only an explicit `archived === true` counts as archived; a
// missing/undefined field keeps the repo in the active set.
export function partitionArchivedRepos(githubRepos: GitHubRepoSyncRecord[]) {
  const active: GitHubRepoSyncRecord[] = [];
  const archived: GitHubRepoSyncRecord[] = [];

  for (const repo of githubRepos) {
    if (repo.archived === true) {
      archived.push(repo);
    } else {
      active.push(repo);
    }
  }

  return { active, archived };
}

export async function syncUserRepos(
  db: RepoTransactionClient,
  userId: string,
  githubRepos: GitHubRepoSyncRecord[],
) {
  const { active, archived } = partitionArchivedRepos(githubRepos);

  const existingTrackedRepos = await db.repo.findMany({
    where: { userId, tracked: true },
    select: { githubId: true },
  });

  // Archived repos are excluded from `active`, so they fall out of
  // `syncedRepoIds` here just like a repo that disappeared from GitHub:
  // if they were tracked, the removedRepoIds branch below untracks them via
  // the same updateMany that already handles "repo no longer on GitHub".
  // Scan history is never deleted, only the `tracked` flag flips to false.
  const removedRepoIds = getRemovedGithubRepoIds(
    existingTrackedRepos.map((repo) => repo.githubId),
    active,
  );

  const operations: Prisma.PrismaPromise<unknown>[] = active.map((repo) =>
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
    syncedCount: active.length,
    removedCount: removedRepoIds.length,
    archivedCount: archived.length,
  };
}
