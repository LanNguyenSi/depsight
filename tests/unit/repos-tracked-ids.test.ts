// Unit tests for lib/repos/tracked-ids.ts -- getTrackedRepoIds.
// Prisma is mocked at the module boundary; no DB access.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { repoFindMany } = vi.hoisted(() => ({
  repoFindMany: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: {
      findMany: repoFindMany,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { getTrackedRepoIds } from '@/lib/repos/tracked-ids';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('getTrackedRepoIds', () => {
  beforeEach(() => {
    repoFindMany.mockReset();
  });

  it('queries only the tracked rows scoped to the given user, selecting id and githubId', async () => {
    repoFindMany.mockResolvedValue([]);

    await getTrackedRepoIds('user-1');

    expect(repoFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', tracked: true },
      select: { id: true, githubId: true },
    });
  });

  it('maps each row\'s id to repoId and keeps githubId', async () => {
    repoFindMany.mockResolvedValue([
      { id: 'repo-cuid-1', githubId: 10001001 },
      { id: 'repo-cuid-2', githubId: 20002002 },
    ]);

    const result = await getTrackedRepoIds('user-1');

    expect(result).toEqual([
      { repoId: 'repo-cuid-1', githubId: 10001001 },
      { repoId: 'repo-cuid-2', githubId: 20002002 },
    ]);
  });

  it('returns an empty array when nothing is tracked', async () => {
    repoFindMany.mockResolvedValue([]);

    const result = await getTrackedRepoIds('user-1');

    expect(result).toEqual([]);
  });
});
