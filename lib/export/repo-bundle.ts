import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createZipArchive, type ZipEntry } from '@/lib/archive/zip';

export type ExportScanType = 'cve' | 'license' | 'deps';

interface ExportRepo {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  language: string | null;
  lastScannedAt: Date | null;
}

export interface RepoExportData {
  repo: ExportRepo;
  cveScan: Awaited<ReturnType<typeof loadCveScan>>;
  licenseScan: Awaited<ReturnType<typeof loadLicenseScan>>;
  depsScan: Awaited<ReturnType<typeof loadDepsScan>>;
}

export interface RepoExportScanOverrides {
  cveScanId?: string;
  licenseScanId?: string;
  depsScanId?: string;
}

function isDependencyScanCandidate(scan: {
  cvePayload: unknown;
  licensePayload: unknown;
  dependencies: Array<unknown>;
  advisories: Array<unknown>;
  licenses: Array<unknown>;
}): boolean {
  if (scan.dependencies.length > 0) return true;
  return scan.cvePayload === null
    && scan.licensePayload === null
    && scan.advisories.length === 0
    && scan.licenses.length === 0;
}

async function loadCveScan(repoId: string, scanId?: string) {
  if (scanId) {
    return prisma.scan.findFirst({
      where: { id: scanId, repoId, status: 'COMPLETED', cvePayload: { not: Prisma.DbNull } },
      include: {
        advisories: {
          orderBy: [{ severity: 'asc' }, { publishedAt: 'desc' }],
        },
      },
    });
  }

  return prisma.scan.findFirst({
    where: { repoId, status: 'COMPLETED', cvePayload: { not: Prisma.DbNull } },
    orderBy: { scannedAt: 'desc' },
    include: {
      advisories: {
        orderBy: [{ severity: 'asc' }, { publishedAt: 'desc' }],
      },
    },
  });
}

async function loadLicenseScan(repoId: string, scanId?: string) {
  if (scanId) {
    return prisma.scan.findFirst({
      where: { id: scanId, repoId, status: 'COMPLETED', licensePayload: { not: Prisma.DbNull } },
      include: {
        licenses: {
          orderBy: [{ policyViolation: 'desc' }, { isCompatible: 'asc' }],
        },
      },
    });
  }

  return prisma.scan.findFirst({
    where: { repoId, status: 'COMPLETED', licensePayload: { not: Prisma.DbNull } },
    orderBy: { scannedAt: 'desc' },
    include: {
      licenses: {
        orderBy: [{ policyViolation: 'desc' }, { isCompatible: 'asc' }],
      },
    },
  });
}

async function loadDepsScan(repoId: string, scanId?: string) {
  if (scanId) {
    const scan = await prisma.scan.findFirst({
      where: { id: scanId, repoId, status: 'COMPLETED' },
      include: {
        dependencies: {
          orderBy: [{ status: 'asc' }, { ageInDays: 'desc' }],
        },
        advisories: {
          select: { id: true },
        },
        licenses: {
          select: { id: true },
        },
      },
    });

    if (!scan) return null;
    if (scan.advisories.length > 0 || scan.licenses.length > 0) return null;
    if (scan.cvePayload !== null || scan.licensePayload !== null) return null;
    return scan;
  }

  const scans = await prisma.scan.findMany({
    where: {
      repoId,
      status: 'COMPLETED',
    },
    orderBy: { scannedAt: 'desc' },
    take: 20,
    include: {
      dependencies: {
        orderBy: [{ status: 'asc' }, { ageInDays: 'desc' }],
      },
      advisories: {
        select: { id: true },
      },
      licenses: {
        select: { id: true },
      },
    },
  });
  return scans.find(isDependencyScanCandidate) ?? null;
}

export async function loadRepoExportData(
  userId: string,
  repoId: string,
  overrides: RepoExportScanOverrides = {},
): Promise<RepoExportData> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId, tracked: true },
    select: {
      id: true,
      fullName: true,
      owner: true,
      name: true,
      defaultBranch: true,
      language: true,
      lastScannedAt: true,
    },
  });

  if (!repo) {
    throw new Error('Repository not found or access denied');
  }

  const [cveScan, licenseScan, depsScan] = await Promise.all([
    loadCveScan(repoId, overrides.cveScanId),
    loadLicenseScan(repoId, overrides.licenseScanId),
    loadDepsScan(repoId, overrides.depsScanId),
  ]);

  return { repo, cveScan, licenseScan, depsScan };
}

export function getMissingExportScans(data: RepoExportData): ExportScanType[] {
  const missing: ExportScanType[] = [];
  if (!data.cveScan) missing.push('cve');
  if (!data.licenseScan) missing.push('license');
  if (!data.depsScan) missing.push('deps');
  return missing;
}

function buildLicenseSummary(licenses: Array<{ license: string }>) {
  const summary: Record<string, number> = {};
  for (const entry of licenses) {
    summary[entry.license] = (summary[entry.license] ?? 0) + 1;
  }
  return summary;
}

function buildDepsSummary(
  dependencies: Array<{ status: 'UP_TO_DATE' | 'OUTDATED' | 'MAJOR_BEHIND' | 'DEPRECATED' | 'UNKNOWN' }>,
) {
  return {
    total: dependencies.length,
    upToDate: dependencies.filter((dep) => dep.status === 'UP_TO_DATE').length,
    outdated: dependencies.filter((dep) => dep.status === 'OUTDATED').length,
    majorBehind: dependencies.filter((dep) => dep.status === 'MAJOR_BEHIND').length,
    deprecated: dependencies.filter((dep) => dep.status === 'DEPRECATED').length,
    unknown: dependencies.filter((dep) => dep.status === 'UNKNOWN').length,
  };
}

export function buildRepoExportArchive(data: RepoExportData): Uint8Array {
  if (!data.cveScan || !data.licenseScan || !data.depsScan) {
    throw new Error('All scans must be available before exporting');
  }

  const exportTimestamp = new Date().toISOString();
  const entries: ZipEntry[] = [];

  const cvePayload = {
    repo: data.repo.fullName,
    scanId: data.cveScan.id,
    scannedAt: data.cveScan.scannedAt.toISOString(),
    riskScore: data.cveScan.riskScore,
    counts: {
      total: data.cveScan.cveCount,
      critical: data.cveScan.criticalCount,
      high: data.cveScan.highCount,
      medium: data.cveScan.mediumCount,
      low: data.cveScan.lowCount,
    },
    advisories: data.cveScan.advisories.map((advisory) => ({
      id: advisory.id,
      ghsaId: advisory.ghsaId,
      cveId: advisory.cveId,
      severity: advisory.severity,
      summary: advisory.summary,
      packageName: advisory.packageName,
      ecosystem: advisory.ecosystem,
      vulnerableRange: advisory.vulnerableRange,
      fixedVersion: advisory.fixedVersion,
      publishedAt: advisory.publishedAt?.toISOString() ?? null,
      url: advisory.url,
    })),
  };

  const licenseSummary = buildLicenseSummary(data.licenseScan.licenses);
  const licensePayload = {
    repo: data.repo.fullName,
    scanId: data.licenseScan.id,
    scannedAt: data.licenseScan.scannedAt.toISOString(),
    licenseCount: data.licenseScan.licenseCount,
    conflictCount: data.licenseScan.licenseIssues,
    summary: licenseSummary,
    licenses: data.licenseScan.licenses.map((license) => ({
      id: license.id,
      packageName: license.packageName,
      version: license.version,
      license: license.license,
      isCompatible: license.isCompatible,
      policyViolation: license.policyViolation,
    })),
  };

  const depsSummary = buildDepsSummary(data.depsScan.dependencies);
  const depsPayload = {
    repo: data.repo.fullName,
    scanId: data.depsScan.id,
    scannedAt: data.depsScan.scannedAt.toISOString(),
    summary: depsSummary,
    dependencies: data.depsScan.dependencies.map((dependency) => ({
      id: dependency.id,
      name: dependency.name,
      installedVersion: dependency.installedVersion,
      latestVersion: dependency.latestVersion,
      ageInDays: dependency.ageInDays,
      status: dependency.status,
      isDeprecated: dependency.isDeprecated,
      updateAvailable: dependency.updateAvailable,
      publishedAt: dependency.publishedAt?.toISOString() ?? null,
      latestPublishedAt: dependency.latestPublishedAt?.toISOString() ?? null,
    })),
  };

  entries.push({
    name: 'metadata.json',
    content: JSON.stringify({
      exportedAt: exportTimestamp,
      repo: {
        id: data.repo.id,
        fullName: data.repo.fullName,
        owner: data.repo.owner,
        name: data.repo.name,
        defaultBranch: data.repo.defaultBranch,
        language: data.repo.language,
        lastScannedAt: data.repo.lastScannedAt?.toISOString() ?? null,
      },
      scans: {
        cve: {
          scanId: data.cveScan.id,
          scannedAt: data.cveScan.scannedAt.toISOString(),
        },
        license: {
          scanId: data.licenseScan.id,
          scannedAt: data.licenseScan.scannedAt.toISOString(),
        },
        deps: {
          scanId: data.depsScan.id,
          scannedAt: data.depsScan.scannedAt.toISOString(),
        },
      },
      files: ['cve.json', 'licenses.json', 'dependencies.json'],
    }, null, 2),
  });
  entries.push({ name: 'cve.json', content: JSON.stringify(cvePayload, null, 2) });
  entries.push({ name: 'licenses.json', content: JSON.stringify(licensePayload, null, 2) });
  entries.push({ name: 'dependencies.json', content: JSON.stringify(depsPayload, null, 2) });

  return createZipArchive(entries);
}
