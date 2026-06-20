import { prisma } from '@/lib/prisma';
import { fetchRepoAdvisories, buildScanResult } from './github-advisories';
import type { ScanResultWithStatus } from './github-advisories';
import { fetchOsvAdvisories } from './osv';
import { mergeCveAdvisories } from './merge';
import { notifyForScan } from '@/lib/alerts/notifier';
import { runPostScanHooks } from '@/lib/alerts/post-scan';
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
    // Fetch Dependabot advisories (source: 'dependabot').
    // A transient Dependabot failure no longer fails the scan because OSV is an
    // independent source; the scan completes with whatever sources succeeded.
    let dependabotResult: ScanResultWithStatus;
    try {
      dependabotResult = await fetchRepoAdvisories(accessToken, repo.owner, repo.name);
    } catch (err) {
      console.error('[scan] Dependabot fetch failed:', err);
      dependabotResult = { ...buildScanResult([]), dependabotDisabled: false };
    }

    // Fetch OSV advisories (never throws; source: 'osv')
    const { advisories: osvAdvisories, ecosystem } = await fetchOsvAdvisories(
      accessToken,
      repo.owner,
      repo.name,
      repo.defaultBranch,
    );

    // Dedup OSV against Dependabot keyed by (identifier, packageName): an OSV
    // finding for a package Dependabot did NOT cover is preserved, and OSV
    // alias-pair duplicates of the same vuln+package collapse to one.
    const mergedAdvisories = mergeCveAdvisories(dependabotResult.advisories, osvAdvisories);
    const merged = buildScanResult(mergedAdvisories);

    // Store advisories and update scan in DB
    await prisma.$transaction(async (tx) => {
      // Bulk create all advisories (Dependabot + OSV deduped)
      if (mergedAdvisories.length > 0) {
        await tx.advisory.createMany({
          data: mergedAdvisories.map((a) => ({
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
            source: a.source,
          })),
        });
      }

      // Update scan with merged counts, risk score, and detected ecosystem
      await tx.scan.update({
        where: { id: scan.id },
        data: {
          status: 'COMPLETED',
          cveCount: merged.counts.total,
          criticalCount: merged.counts.critical,
          highCount: merged.counts.high,
          mediumCount: merged.counts.medium,
          lowCount: merged.counts.low,
          riskScore: merged.riskScore,
          cvePayload: JSON.parse(JSON.stringify(mergedAdvisories)),
          ecosystem,
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
      notifyForScan(userId, repoId, repo.fullName, scan.id, merged.riskScore, savedAdvisories).catch(
        (err) => console.error('Notification error:', err),
      );
    }

    // Fire post-scan hooks: policy eval + scan.completed webhook (non-blocking)
    runPostScanHooks(userId, repoId, repo.fullName, scan.id, 'cve', {
      cveCount: merged.counts.total,
      riskScore: merged.riskScore,
      criticalCount: merged.counts.critical,
      highCount: merged.counts.high,
    }).catch((err) => console.error('[post-scan] cve hook error:', err));

    return {
      scanId: scan.id,
      dependabotDisabled: dependabotResult.dependabotDisabled,
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
