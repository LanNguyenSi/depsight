import { prisma } from '@/lib/prisma';
import { detectLicenses } from './detector';
import { runPostScanHooks } from '@/lib/alerts/post-scan';
import { scanDegradedData, scanSuccessData } from '@/lib/scan/freshness';
import { trackDegraded } from '@/lib/scan/degraded';
import { recordScanFailure } from '@/lib/scan/record-failure';

export async function scanLicenses(
  userId: string,
  repoId: string,
  accessToken: string,
): Promise<{ scanId: string; licenseCount: number; conflictCount: number }> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId, tracked: true },
  });
  if (!repo) throw new Error('Repository not found or access denied');

  // Always create a fresh scan record (avoid race conditions with CVE scans)
  const scan = await prisma.scan.create({
    data: { repoId, status: 'RUNNING' },
  });

  try {
    // A source that cannot be read (revoked token, outage) must not look like
    // "read, no manifests / no license file"; see lib/scan/degraded.ts.
    const { value: result, degraded } = await trackDegraded(() =>
      detectLicenses(accessToken, repo.owner, repo.name, repo.defaultBranch),
    );

    await prisma.$transaction(async (tx) => {
      if (result.licenses.length > 0) {
        await tx.licenseResult.createMany({
          data: result.licenses.map((l) => ({
            scanId: scan.id,
            packageName: l.packageName,
            version: l.version,
            license: l.license,
            isCompatible: l.isCompatible,
            policyViolation: l.policyViolation,
          })),
        });
      }

      await tx.scan.update({
        where: { id: scan.id },
        data: {
          status: 'COMPLETED',
          licenseCount: result.licenses.length,
          licenseIssues: result.conflictCount,
          licensePayload: JSON.parse(JSON.stringify(result.licenses)),
        },
      });

      await tx.repo.update({
        where: { id: repoId },
        data: degraded === null ? scanSuccessData('license') : scanDegradedData('license', degraded),
      });
    });

    // Fire post-scan hooks: policy eval + scan.completed webhook (non-blocking)
    runPostScanHooks(userId, repoId, repo.fullName, scan.id, 'license', {
      licenseCount: result.licenses.length,
      conflictCount: result.conflictCount,
    }).catch((err) => console.error('[post-scan] license hook error:', err));

    return {
      scanId: scan.id,
      licenseCount: result.licenses.length,
      conflictCount: result.conflictCount,
    };
  } catch (error) {
    // Record the failure on the repo first so it is kept even if the scan row update fails
    await recordScanFailure(repoId, 'license', error);
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'License scan failed',
      },
    });
    throw error;
  }
}
