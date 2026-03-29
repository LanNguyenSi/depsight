import { prisma } from '@/lib/prisma';
import { analyzeDepAge } from './age-checker';

export async function scanDependencies(
  userId: string,
  repoId: string,
  accessToken: string,
): Promise<{ scanId: string; summary: Awaited<ReturnType<typeof analyzeDepAge>>['summary'] }> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId, tracked: true },
  });
  if (!repo) {
    throw new Error('Repository not found or access denied');
  }

  const result = await analyzeDepAge(accessToken, repo.owner, repo.name);

  // Always create a fresh scan record (avoid race conditions with CVE/license scans)
  const scan = await prisma.scan.create({
    data: { repoId, status: 'RUNNING' },
  });

  try {
    await prisma.$transaction(async (tx) => {
      if (result.dependencies.length > 0) {
        await tx.dependency.createMany({
          data: result.dependencies.map((d) => ({
            scanId: scan.id,
            name: d.name,
            installedVersion: d.installedVersion,
            latestVersion: d.latestVersion,
            publishedAt: d.publishedAt,
            ageInDays: d.ageInDays >= 0 ? d.ageInDays : null,
            status: d.status,
            isDeprecated: d.isDeprecated,
            updateAvailable: d.updateAvailable,
            latestPublishedAt: d.latestPublishedAt,
          })),
        });
      }

      await tx.scan.update({
        where: { id: scan.id },
        data: { status: 'COMPLETED' },
      });

      await tx.repo.update({
        where: { id: repoId },
        data: { lastScannedAt: new Date() },
      });
    });

    return {
      scanId: scan.id,
      summary: result.summary,
    };
  } catch (error) {
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Dependency analysis failed',
      },
    });
    throw error;
  }
}
