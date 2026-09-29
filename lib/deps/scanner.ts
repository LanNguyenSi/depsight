import { prisma } from '@/lib/prisma';
import { analyzeDepAge } from './age-checker';
import { runPostScanHooks } from '@/lib/alerts/post-scan';
import { scanDegradedData, scanDegradedReason, scanSuccessData } from '@/lib/scan/freshness';
import { trackDegraded } from '@/lib/scan/degraded';
import { recordScanFailure } from '@/lib/scan/record-failure';

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

  // Runs before the scan row exists, so a failure here has no FAILED scan to
  // show it; record it on the repo so the failure stays visible.
  // A source that cannot be read (revoked token, outage) must not look like
  // "read, no manifests"; see lib/scan/degraded.ts.
  let result: Awaited<ReturnType<typeof analyzeDepAge>>;
  let degraded: string | null;
  try {
    ({ value: result, degraded } = await trackDegraded(() =>
      analyzeDepAge(accessToken, repo.owner, repo.name, repo.defaultBranch),
    ));
  } catch (error) {
    await recordScanFailure(repoId, 'deps', error);
    throw error;
  }

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
        data: { status: 'COMPLETED', degradedReason: scanDegradedReason(degraded) },
      });

      await tx.repo.update({
        where: { id: repoId },
        data: degraded === null ? scanSuccessData('deps') : scanDegradedData('deps', degraded),
      });
    });

    // Fire post-scan hooks: policy eval + scan.completed webhook (non-blocking)
    // analyzeDepAge().summary is a concrete numeric object without an index
    // signature, so the double-cast satisfies ScanCompletedPayload.summary (Record<string,unknown>).
    runPostScanHooks(userId, repoId, repo.fullName, scan.id, 'deps', {
      summary: result.summary as unknown as Record<string, unknown>,
    }, scanDegradedReason(degraded)).catch((err) => console.error('[post-scan] deps hook error:', err));

    return {
      scanId: scan.id,
      summary: result.summary,
    };
  } catch (error) {
    // Record the failure on the repo first so it is kept even if the scan row update fails
    await recordScanFailure(repoId, 'deps', error);
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
