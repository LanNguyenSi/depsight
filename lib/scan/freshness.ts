// Per-scanner freshness for a repo. Pure helpers (no prisma import) so both the
// scanners and client components can use them.
//
// Repo.lastScannedAt only says "some scanner succeeded at this time". Each
// scanner also stamps its own success time and keeps its last failure message,
// so a scanner that keeps throwing stays visible while the others advance.

export type ScannerKey = 'cve' | 'license' | 'deps';

export const SCANNER_KEYS: readonly ScannerKey[] = ['cve', 'license', 'deps'];

export interface ScannerStatus {
  /** ISO timestamp of this scanner's last success, or null if it never succeeded since tracking began. */
  lastSuccessAt: string | null;
  /** Last failure message while the scanner is failing; null once it succeeds again. */
  error: string | null;
}

export type ScannerStatuses = Record<ScannerKey, ScannerStatus>;

/** The Repo columns the per-scanner status is derived from. */
export interface RepoScannerColumns {
  cveScannedAt: Date | null;
  licenseScannedAt: Date | null;
  depsScannedAt: Date | null;
  cveScanError: string | null;
  licenseScanError: string | null;
  depsScanError: string | null;
}

const MAX_ERROR_LENGTH = 500;

/**
 * Repo update data for a successful scan: advances this scanner's timestamp,
 * clears its failure state, and advances lastScannedAt (any scanner succeeded).
 */
export function scanSuccessData(scanner: ScannerKey, now: Date = new Date()) {
  switch (scanner) {
    case 'cve':
      return { lastScannedAt: now, cveScannedAt: now, cveScanError: null };
    case 'license':
      return { lastScannedAt: now, licenseScannedAt: now, licenseScanError: null };
    case 'deps':
      return { lastScannedAt: now, depsScannedAt: now, depsScanError: null };
  }
}

/**
 * Repo update data for a failed scan: records the failure message only. The
 * scanner's success timestamp and lastScannedAt are deliberately left alone.
 */
export function scanFailureData(scanner: ScannerKey, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH) || 'Scan failed';
  switch (scanner) {
    case 'cve':
      return { cveScanError: message };
    case 'license':
      return { licenseScanError: message };
    case 'deps':
      return { depsScanError: message };
  }
}

/**
 * Repo update data for a degraded scan: the scanner ran and stored what it
 * found, but a source could not be read (revoked token, GitHub or OSV outage),
 * so the empty or partial result is not proof that nothing is there. Records
 * the reasons through the same failure marker a thrown scan uses and, like a
 * failure, leaves the scanner's success timestamp and lastScannedAt alone.
 */
export function scanDegradedData(scanner: ScannerKey, reasons: string) {
  return scanFailureData(scanner, `Source unreadable, result may be incomplete: ${reasons}`);
}

/**
 * The value stored on a Scan row (and exposed by the scan.completed webhook,
 * POST /api/scan and the MCP rescan answer) for a run's degraded reason: the
 * classified reason line the degraded tracker produced, cut to the same bound
 * as the per-scanner failure message, or null when every source was read.
 */
export function scanDegradedReason(degraded: string | null): string | null {
  return degraded === null ? null : degraded.slice(0, MAX_ERROR_LENGTH);
}

export function getScannerStatuses(repo: RepoScannerColumns): ScannerStatuses {
  return {
    cve: { lastSuccessAt: repo.cveScannedAt?.toISOString() ?? null, error: repo.cveScanError ?? null },
    license: { lastSuccessAt: repo.licenseScannedAt?.toISOString() ?? null, error: repo.licenseScanError ?? null },
    deps: { lastSuccessAt: repo.depsScannedAt?.toISOString() ?? null, error: repo.depsScanError ?? null },
  };
}

/** Scanners currently failing, in a stable order. */
export function failingScanners(statuses: ScannerStatuses): ScannerKey[] {
  return SCANNER_KEYS.filter((key) => statuses[key].error !== null);
}
