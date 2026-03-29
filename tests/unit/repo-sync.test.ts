import { describe, expect, it, vi } from 'vitest';
import { getRemovedGithubRepoIds, syncUserRepos, type GitHubRepoSyncRecord } from '@/lib/repos/sync';

function makeGitHubRepo(overrides: Partial<GitHubRepoSyncRecord> = {}): GitHubRepoSyncRecord {
  return {
    id: overrides.id ?? 101,
    name: overrides.name ?? 'depsight',
    fullName: overrides.fullName ?? 'acme/depsight',
    private: overrides.private ?? false,
    defaultBranch: overrides.defaultBranch ?? 'main',
    language: overrides.language ?? 'TypeScript',
    owner: overrides.owner ?? { login: 'acme' },
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
    expect(result).toEqual({ syncedCount: 1, removedCount: 1 });
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
    expect(result).toEqual({ syncedCount: 1, removedCount: 0 });
  });
});
