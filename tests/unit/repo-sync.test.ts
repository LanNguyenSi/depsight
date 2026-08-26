import { describe, expect, it, vi } from 'vitest';
import {
  getRemovedGithubRepoIds,
  partitionArchivedRepos,
  syncUserRepos,
  type GitHubRepoSyncRecord,
} from '@/lib/repos/sync';

function makeGitHubRepo(overrides: Partial<GitHubRepoSyncRecord> = {}): GitHubRepoSyncRecord {
  return {
    id: overrides.id ?? 101,
    name: overrides.name ?? 'depsight',
    fullName: overrides.fullName ?? 'acme/depsight',
    private: overrides.private ?? false,
    defaultBranch: overrides.defaultBranch ?? 'main',
    language: overrides.language ?? 'TypeScript',
    owner: overrides.owner ?? { login: 'acme' },
    archived: overrides.archived,
  };
}

function makeDb(existingTracked: Array<{ githubId: number }>) {
  const findMany = vi.fn().mockResolvedValue(existingTracked);
  const upsert = vi.fn().mockImplementation((args) => args);
  const updateMany = vi.fn().mockImplementation((args) => args);
  const transaction = vi.fn().mockResolvedValue(undefined);

  return {
    db: {
      repo: { findMany, upsert, updateMany },
      $transaction: transaction,
    },
    findMany,
    upsert,
    updateMany,
    transaction,
  };
}

describe('repo sync', () => {
  it('detects repos that disappeared from the latest GitHub sync', () => {
    const removedRepoIds = getRemovedGithubRepoIds(
      [101, 202, 303],
      [makeGitHubRepo({ id: 101 }), makeGitHubRepo({ id: 303, name: 'web', fullName: 'acme/web' })],
    );

    expect(removedRepoIds).toEqual([202]);
  });

  it('marks missing repos as untracked while keeping synced repos active', async () => {
    const findMany = vi.fn().mockResolvedValue([{ githubId: 101 }, { githubId: 202 }]);
    const upsert = vi.fn().mockImplementation((args) => args);
    const updateMany = vi.fn().mockImplementation((args) => args);
    const transaction = vi.fn().mockResolvedValue(undefined);

    const db = {
      repo: {
        findMany,
        upsert,
        updateMany,
      },
      $transaction: transaction,
    };

    const result = await syncUserRepos(db, 'user-1', [makeGitHubRepo({ id: 101 })]);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', tracked: true },
      select: { githubId: true },
    });

    expect(upsert).toHaveBeenCalledWith({
      where: {
        userId_githubId: {
          userId: 'user-1',
          githubId: 101,
        },
      },
      update: {
        name: 'depsight',
        fullName: 'acme/depsight',
        owner: 'acme',
        private: false,
        defaultBranch: 'main',
        language: 'TypeScript',
        tracked: true,
      },
      create: {
        userId: 'user-1',
        githubId: 101,
        name: 'depsight',
        fullName: 'acme/depsight',
        owner: 'acme',
        private: false,
        defaultBranch: 'main',
        language: 'TypeScript',
        tracked: true,
      },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        githubId: { in: [202] },
        tracked: true,
      },
      data: { tracked: false },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ syncedCount: 1, removedCount: 1, archivedCount: 0 });
  });

  it('skips the untrack update when nothing was removed', async () => {
    const findMany = vi.fn().mockResolvedValue([{ githubId: 101 }]);
    const upsert = vi.fn().mockImplementation((args) => args);
    const updateMany = vi.fn().mockImplementation((args) => args);
    const transaction = vi.fn().mockResolvedValue(undefined);

    const db = {
      repo: {
        findMany,
        upsert,
        updateMany,
      },
      $transaction: transaction,
    };

    const result = await syncUserRepos(db, 'user-1', [makeGitHubRepo({ id: 101 })]);

    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ syncedCount: 1, removedCount: 0, archivedCount: 0 });
  });

  it('partitions an archived repo away from an active repo', () => {
    const active = makeGitHubRepo({ id: 101, archived: false });
    const archivedRepo = makeGitHubRepo({ id: 202, name: 'boardflow', fullName: 'acme/boardflow', archived: true });

    const result = partitionArchivedRepos([active, archivedRepo]);

    expect(result.active).toEqual([active]);
    expect(result.archived).toEqual([archivedRepo]);
  });

  it('untracks a previously-tracked repo that GitHub now reports as archived, without deleting scan history', async () => {
    const { db, upsert, updateMany, transaction } = makeDb([{ githubId: 101 }, { githubId: 202 }]);

    // repo 202 (boardflow) is still returned by the GitHub sync, but now archived=true.
    const result = await syncUserRepos(db, 'user-1', [
      makeGitHubRepo({ id: 101, archived: false }),
      makeGitHubRepo({ id: 202, name: 'boardflow', fullName: 'acme/boardflow', archived: true }),
    ]);

    // Only the active repo is upserted; the archived repo is never re-created or updated.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_githubId: { userId: 'user-1', githubId: 101 } },
    }));

    // The archived repo is untracked via the same updateMany path used for
    // repos that disappeared from GitHub — no delete, only tracked: false.
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', githubId: { in: [202] }, tracked: true },
      data: { tracked: false },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ syncedCount: 1, removedCount: 1, archivedCount: 1 });
  });

  it('fail-safe: keeps a repo tracked when the archived field is missing from the GitHub response', async () => {
    const { db, upsert, updateMany } = makeDb([{ githubId: 101 }]);

    // No `archived` key at all (as if the GitHub API response omitted it).
    const repoWithoutArchivedField = makeGitHubRepo({ id: 101 });
    delete (repoWithoutArchivedField as { archived?: boolean }).archived;

    const result = await syncUserRepos(db, 'user-1', [repoWithoutArchivedField]);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ tracked: true }),
    }));
    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ syncedCount: 1, removedCount: 0, archivedCount: 0 });
  });
});
