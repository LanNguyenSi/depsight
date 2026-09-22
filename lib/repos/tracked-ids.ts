import { prisma } from '@/lib/prisma';

export interface TrackedRepoId {
  repoId: string;
  githubId: number;
}

/**
 * Each tracked repo's own `repoId` (depsight's cuid) paired with GitHub's
 * numeric `githubId`. Read-only: no scan/CVE/license/CI joins and no
 * team-health computation (see lib/overview/team-health.ts for that). Cheap
 * enough for a per-request caller -- such as the MCP list tool's repoId
 * merge -- to call on every request instead of paying for the full
 * overview aggregation.
 */
export async function getTrackedRepoIds(userId: string): Promise<TrackedRepoId[]> {
  const repos = await prisma.repo.findMany({
    where: { userId, tracked: true },
    select: { id: true, githubId: true },
  });
  return repos.map((repo) => ({ repoId: repo.id, githubId: repo.githubId }));
}
