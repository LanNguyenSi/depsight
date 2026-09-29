import { prisma } from '@/lib/prisma';
import { scanFailureData, type ScannerKey } from './freshness';

/**
 * Record that a scanner failed for a repo. Best effort: a failure to write the
 * marker must never replace the scanner's own error, so it is logged and
 * swallowed.
 */
export async function recordScanFailure(repoId: string, scanner: ScannerKey, error: unknown): Promise<void> {
  try {
    await prisma.repo.update({ where: { id: repoId }, data: scanFailureData(scanner, error) });
  } catch (writeError) {
    console.error(`[scan] Could not record ${scanner} scan failure for repo ${repoId}:`, writeError);
  }
}
