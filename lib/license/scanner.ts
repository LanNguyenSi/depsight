import { prisma } from '@/lib/prisma';
import { detectLicenses } from './detector';

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
    const result = await detectLicenses(accessToken, repo.owner, repo.name);

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
        data: { lastScannedAt: new Date() },
      });
    });

    return {
      scanId: scan.id,
      licenseCount: result.licenses.length,
      conflictCount: result.conflictCount,
    };
  } catch (error) {
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
