import { prisma } from '@/lib/prisma';
import { detectLicenses } from './detector';

export async function scanLicenses(
  userId: string,
  repoId: string,
  accessToken: string,
): Promise<{ scanId: string; licenseCount: number; conflictCount: number }> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId },
  });

  if (!repo) throw new Error('Repository not found or access denied');

  // Get or create the latest scan for this repo
  let scan = await prisma.scan.findFirst({
    where: { repoId, status: 'COMPLETED' },
    orderBy: { scannedAt: 'desc' },
  });

  if (!scan) {
    scan = await prisma.scan.create({
      data: { repoId, status: 'RUNNING' },
    });
  }

  try {
    const result = await detectLicenses(accessToken, repo.owner, repo.name);

    await prisma.$transaction(async (tx) => {
      // Delete old license results for this scan
      await tx.licenseResult.deleteMany({ where: { scanId: scan!.id } });

      if (result.licenses.length > 0) {
        await tx.licenseResult.createMany({
          data: result.licenses.map((l) => ({
            scanId: scan!.id,
            packageName: l.packageName,
            version: l.version,
            license: l.license,
            isCompatible: l.isCompatible,
            policyViolation: l.policyViolation,
          })),
        });
      }

      await tx.scan.update({
        where: { id: scan!.id },
        data: {
          status: 'COMPLETED',
          licenseCount: result.licenses.length,
          licenseIssues: result.conflictCount,
          licensePayload: JSON.parse(JSON.stringify(result.licenses)),
        },
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
