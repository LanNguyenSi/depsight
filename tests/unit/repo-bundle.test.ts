// Unit tests for the two pure exported functions in lib/export/repo-bundle.ts.
// No prisma mock needed: getMissingExportScans and buildRepoExportArchive operate
// entirely on the RepoExportData object and the pure createZipArchive function.
import { describe, it, expect } from 'vitest';
import { getMissingExportScans, buildRepoExportArchive } from '@/lib/export/repo-bundle';
import type { RepoExportData } from '@/lib/export/repo-bundle';

// ---------------------------------------------------------------------------
// Helpers — minimal scan stubs shaped like Prisma query results
// ---------------------------------------------------------------------------

function makeRepo() {
  return {
    id: 'repo-1',
    fullName: 'owner/repo',
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    language: 'TypeScript',
    lastScannedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function makeCveScan() {
  return {
    id: 'scan-cve-1',
    scannedAt: new Date('2026-01-01T00:00:00Z'),
    riskScore: 7.5,
    cveCount: 1,
    criticalCount: 1,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    advisories: [
      {
        id: 'adv-1',
        ghsaId: 'GHSA-xxxx-yyyy-zzzz',
        cveId: 'CVE-2026-0001',
        severity: 'CRITICAL',
        summary: 'A critical vulnerability',
        packageName: 'lodash',
        ecosystem: 'npm',
        vulnerableRange: '< 4.17.21',
        fixedVersion: '4.17.21',
        publishedAt: new Date('2025-06-01T00:00:00Z'),
        url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
      },
    ],
  };
}

function makeLicenseScan() {
  return {
    id: 'scan-lic-1',
    scannedAt: new Date('2026-01-01T00:00:00Z'),
    licenseCount: 3,
    licenseIssues: 1,
    licenses: [
      {
        id: 'lic-1',
        license: 'MIT',
        packageName: 'lodash',
        version: '4.17.21',
        isCompatible: true,
        policyViolation: false,
      },
    ],
  };
}

function makeDepsScan() {
  return {
    id: 'scan-dep-1',
    scannedAt: new Date('2026-01-01T00:00:00Z'),
    dependencies: [
      {
        id: 'dep-1',
        name: 'lodash',
        status: 'UP_TO_DATE' as const,
        installedVersion: '4.17.21',
        latestVersion: '4.17.21',
        ageInDays: 365,
        isDeprecated: false,
        updateAvailable: false,
        publishedAt: new Date('2025-01-01T00:00:00Z'),
        latestPublishedAt: new Date('2025-01-01T00:00:00Z'),
      },
    ],
  };
}

function makeFullData(): RepoExportData {
  return {
    repo: makeRepo(),
    cveScan: makeCveScan(),
    licenseScan: makeLicenseScan(),
    depsScan: makeDepsScan(),
  } as unknown as RepoExportData;
}

// ---------------------------------------------------------------------------
// getMissingExportScans
// ---------------------------------------------------------------------------
describe('getMissingExportScans', () => {
  it('returns empty array when all three scans are present', () => {
    const data = makeFullData();

    const missing = getMissingExportScans(data);

    expect(missing).toEqual([]);
  });

  it('returns ["cve"] when cveScan is null', () => {
    const data = { ...makeFullData(), cveScan: null } as unknown as RepoExportData;

    const missing = getMissingExportScans(data);

    expect(missing).toEqual(['cve']);
  });

  it('returns ["license"] when licenseScan is null', () => {
    const data = { ...makeFullData(), licenseScan: null } as unknown as RepoExportData;

    const missing = getMissingExportScans(data);

    expect(missing).toEqual(['license']);
  });

  it('returns ["deps"] when depsScan is null', () => {
    const data = { ...makeFullData(), depsScan: null } as unknown as RepoExportData;

    const missing = getMissingExportScans(data);

    expect(missing).toEqual(['deps']);
  });

  it('returns all three when all scans are null', () => {
    const data = {
      ...makeFullData(),
      cveScan: null,
      licenseScan: null,
      depsScan: null,
    } as unknown as RepoExportData;

    const missing = getMissingExportScans(data);

    expect(missing).toEqual(['cve', 'license', 'deps']);
  });

  it('returns ["cve","deps"] when licenseScan is present but others are null', () => {
    const data = {
      ...makeFullData(),
      cveScan: null,
      depsScan: null,
    } as unknown as RepoExportData;

    const missing = getMissingExportScans(data);

    expect(missing).toEqual(['cve', 'deps']);
  });
});

// ---------------------------------------------------------------------------
// buildRepoExportArchive
// ---------------------------------------------------------------------------
describe('buildRepoExportArchive', () => {
  it('throws when cveScan is null', () => {
    const data = { ...makeFullData(), cveScan: null } as unknown as RepoExportData;

    expect(() => buildRepoExportArchive(data)).toThrow('All scans must be available before exporting');
  });

  it('throws when licenseScan is null', () => {
    const data = { ...makeFullData(), licenseScan: null } as unknown as RepoExportData;

    expect(() => buildRepoExportArchive(data)).toThrow('All scans must be available before exporting');
  });

  it('throws when depsScan is null', () => {
    const data = { ...makeFullData(), depsScan: null } as unknown as RepoExportData;

    expect(() => buildRepoExportArchive(data)).toThrow('All scans must be available before exporting');
  });

  it('returns a non-empty Uint8Array when all scans are present', () => {
    const data = makeFullData();

    const archive = buildRepoExportArchive(data);

    expect(archive).toBeInstanceOf(Uint8Array);
    expect(archive.length).toBeGreaterThan(0);
  });

  it('produces a ZIP archive (magic bytes PK\\x03\\x04 at offset 0)', () => {
    const data = makeFullData();

    const archive = buildRepoExportArchive(data);

    // ZIP local file header signature: 0x50 0x4B 0x03 0x04
    expect(archive[0]).toBe(0x50); // 'P'
    expect(archive[1]).toBe(0x4b); // 'K'
    expect(archive[2]).toBe(0x03);
    expect(archive[3]).toBe(0x04);
  });

  it('archive contains 4 entries (metadata.json, cve.json, licenses.json, dependencies.json)', () => {
    const data = makeFullData();

    const archive = buildRepoExportArchive(data);
    const text = new TextDecoder().decode(archive);

    // Each entry's filename appears in both the local file header and the central directory.
    // We check that the expected filenames are present in the archive bytes.
    expect(text).toContain('metadata.json');
    expect(text).toContain('cve.json');
    expect(text).toContain('licenses.json');
    expect(text).toContain('dependencies.json');
  });

  it('cve.json entry in archive contains the repo fullName and scan id', () => {
    const data = makeFullData();

    const archive = buildRepoExportArchive(data);
    const text = new TextDecoder().decode(archive);

    expect(text).toContain('owner/repo');
    expect(text).toContain('scan-cve-1');
    expect(text).toContain('GHSA-xxxx-yyyy-zzzz');
  });

  it('handles advisory with null publishedAt without throwing', () => {
    const data = makeFullData();
    // Cast to unknown to set publishedAt null on the advisory
    const cveScan = makeCveScan();
    cveScan.advisories[0] = { ...cveScan.advisories[0], publishedAt: null as unknown as Date };
    const dataWithNull = { ...data, cveScan } as unknown as RepoExportData;

    expect(() => buildRepoExportArchive(dataWithNull)).not.toThrow();
  });
});
