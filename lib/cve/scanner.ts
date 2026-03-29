import { prisma } from '@/lib/prisma';
import { fetchRepoAdvisories } from './github-advisories';
import { notifyForScan } from '@/lib/alerts/notifier';
import type { Severity as PrismaSeverity } from '@prisma/client';

export interface ScanRepositoryResult {
  scanId: string;
  dependabotDisabled?: boolean;
}

export async function scanRepository(
  userId: string,
  repoId: string,
  accessToken: string,
): Promise<ScanRepositoryResult> {
  // Get repo info from DB
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId, tracked: true },
  });

  if (!repo) {
    throw new Error('Repository not found or access denied');
  }

  // Create a pending scan
  const scan = await prisma.scan.create({
    data: {
      repoId,
      status: 'RUNNING',
    },
  });

  try {
    // Fetch advisories from GitHub
    const result = await fetchRepoAdvisories(accessToken, repo.owner, repo.name);

    // Store advisories in DB
    await prisma.$transaction(async (tx) => {
      // Bulk create advisories
      if (result.advisories.length > 0) {
        await tx.advisory.createMany({
          data: result.advisories.map((a) => ({
            scanId: scan.id,
            ghsaId: a.ghsaId,
            cveId: a.cveId,
            severity: a.severity as PrismaSeverity,
            summary: a.summary,
            packageName: a.packageName,
            ecosystem: a.ecosystem,
            vulnerableRange: a.vulnerableRange,
            fixedVersion: a.fixedVersion,
            publishedAt: a.publishedAt,
            url: a.url,
          })),
        });
      }

      // Update scan with results
      await tx.scan.update({
        where: { id: scan.id },
        data: {
          status: 'COMPLETED',
          cveCount: result.counts.total,
          criticalCount: result.counts.critical,
          highCount: result.counts.high,
          mediumCount: result.counts.medium,
          lowCount: result.counts.low,
          riskScore: result.riskScore,
          cvePayload: JSON.parse(JSON.stringify(result.advisories)),
        },
      });

      // Update repo last scanned timestamp
      await tx.repo.update({
        where: { id: repoId },
        data: { lastScannedAt: new Date() },
      });
    });

    // Fire notifications for critical/high CVEs (non-blocking)
    const savedAdvisories = await prisma.advisory.findMany({
      where: { scanId: scan.id, severity: { in: ['CRITICAL', 'HIGH'] } },
    });
    if (savedAdvisories.length > 0) {
      notifyForScan(userId, repoId, repo.fullName, scan.id, result.riskScore, savedAdvisories).catch(
        (err) => console.error('Notification error:', err),
      );
    }

    return {
      scanId: scan.id,
      dependabotDisabled: result.dependabotDisabled,
    };
  } catch (error) {
    // Mark scan as failed
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    throw error;
  }
}
