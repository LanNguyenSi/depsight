import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  osvEcosystem,
  cvssV3BaseScore,
  mapOsvSeverity,
  extractAliases,
  type OsvVuln,
} from '@/lib/cve/osv';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- osvEcosystem ----------------------------------------------------------

describe('osvEcosystem', () => {
  it.each([
    ['npm', 'npm'],
    ['python', 'PyPI'],
    ['go', 'Go'],
    ['java', 'Maven'],
    ['rust', 'crates.io'],
    ['php', 'Packagist'],
  ] as const)('maps %s -> %s', (eco, expected) => {
    expect(osvEcosystem(eco)).toBe(expected);
  });

  it.each(['ruby', 'dotnet', 'unknown', 'swift', ''])(
    'returns null for unsupported ecosystem "%s"',
    (eco) => {
      expect(osvEcosystem(eco)).toBeNull();
    },
  );
});

// ---- cvssV3BaseScore -------------------------------------------------------

describe('cvssV3BaseScore', () => {
  it('scores CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H as ~9.8 (CRITICAL)', () => {
    const score = cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
    expect(score).toBeCloseTo(9.8, 1);
    expect(score).toBeGreaterThanOrEqual(9.0);
  });

  it('scores CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N as ~4.3 (MEDIUM)', () => {
    // ISCBase = 0.22; ISC = 6.42*0.22 = 1.4124
    // Exploitability = 8.22*0.85*0.77*0.62*0.85 ≈ 2.835
    // BaseScore = Roundup(4.247) = 4.3
    const score = cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N');
    expect(score).toBeCloseTo(4.3, 1);
    expect(score).toBeGreaterThanOrEqual(4.0);
    expect(score).toBeLessThan(7.0);
  });

  it('returns 0 when all impact metrics are N (no impact)', () => {
    const score = cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N');
    expect(score).toBe(0);
  });

  it('returns 0 for an empty vector string', () => {
    expect(cvssV3BaseScore('')).toBe(0);
  });

  it('returns 0 for a malformed vector', () => {
    expect(cvssV3BaseScore('not-a-vector')).toBe(0);
  });

  it('handles scope-changed vectors correctly (PR values differ)', () => {
    // CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H = 10.0 (capped)
    const score = cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H');
    expect(score).toBe(10.0);
  });
});

// ---- mapOsvSeverity --------------------------------------------------------

describe('mapOsvSeverity', () => {
  it('returns CRITICAL from database_specific.severity', () => {
    const vuln: OsvVuln = { id: 'T-1', database_specific: { severity: 'CRITICAL' } };
    expect(mapOsvSeverity(vuln)).toBe('CRITICAL');
  });

  it('maps MODERATE to MEDIUM', () => {
    const vuln: OsvVuln = { id: 'T-2', database_specific: { severity: 'MODERATE' } };
    expect(mapOsvSeverity(vuln)).toBe('MEDIUM');
  });

  it('maps MEDIUM to MEDIUM', () => {
    const vuln: OsvVuln = { id: 'T-3', database_specific: { severity: 'MEDIUM' } };
    expect(mapOsvSeverity(vuln)).toBe('MEDIUM');
  });

  it('database_specific severity wins over CVSS_V3', () => {
    const vuln: OsvVuln = {
      id: 'T-4',
      database_specific: { severity: 'LOW' },
      // CVSS would score 9.8 CRITICAL, but database_specific wins
      severity: [
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      ],
    };
    expect(mapOsvSeverity(vuln)).toBe('LOW');
  });

  it('falls back to CVSS_V3 score when database_specific is absent', () => {
    const vuln: OsvVuln = {
      id: 'T-5',
      severity: [
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      ],
    };
    expect(mapOsvSeverity(vuln)).toBe('CRITICAL');
  });

  it('falls back to CVSS_V3 and returns HIGH for a 7.5 score', () => {
    // AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N => 7.5
    const vuln: OsvVuln = {
      id: 'T-6',
      severity: [
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
      ],
    };
    expect(mapOsvSeverity(vuln)).toBe('HIGH');
  });

  it('ignores CVSS_V4 entries and returns UNKNOWN when only V4 is present', () => {
    const vuln: OsvVuln = {
      id: 'T-7',
      severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/...' }],
    };
    expect(mapOsvSeverity(vuln)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when no severity info is available', () => {
    const vuln: OsvVuln = { id: 'T-8' };
    expect(mapOsvSeverity(vuln)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an unrecognised database_specific severity string', () => {
    const vuln: OsvVuln = { id: 'T-9', database_specific: { severity: 'INFORMATIONAL' } };
    expect(mapOsvSeverity(vuln)).toBe('UNKNOWN');
  });
});

// ---- extractAliases --------------------------------------------------------

describe('extractAliases', () => {
  it('prefers GHSA alias from aliases array', () => {
    const { ghsaId, cveId } = extractAliases({
      id: 'OSV-2023-1234',
      aliases: ['GHSA-xxxx-yyyy-zzzz', 'CVE-2023-12345'],
    });
    expect(ghsaId).toBe('GHSA-xxxx-yyyy-zzzz');
    expect(cveId).toBe('CVE-2023-12345');
  });

  it('uses vuln id as ghsaId when id starts with GHSA- (no GHSA alias)', () => {
    const { ghsaId, cveId } = extractAliases({
      id: 'GHSA-1234-5678-abcd',
      aliases: ['CVE-2023-99999'],
    });
    expect(ghsaId).toBe('GHSA-1234-5678-abcd');
    expect(cveId).toBe('CVE-2023-99999');
  });

  it('falls back to OSV id as ghsaId when no GHSA alias exists', () => {
    const { ghsaId, cveId } = extractAliases({
      id: 'OSV-2023-5678',
      aliases: [],
    });
    expect(ghsaId).toBe('OSV-2023-5678');
    expect(cveId).toBeNull();
  });

  it('extracts CVE alias even when id is a non-CVE OSV id', () => {
    const { ghsaId, cveId } = extractAliases({
      id: 'PYSEC-2023-100',
      aliases: ['CVE-2023-54321'],
    });
    expect(ghsaId).toBe('PYSEC-2023-100');
    expect(cveId).toBe('CVE-2023-54321');
  });

  it('sets cveId from id when id starts with CVE- and aliases is empty', () => {
    const { ghsaId, cveId } = extractAliases({
      id: 'CVE-2023-99999',
      aliases: [],
    });
    // ghsaId is the id itself (canonical fallback)
    expect(ghsaId).toBe('CVE-2023-99999');
    expect(cveId).toBe('CVE-2023-99999');
  });

  it('handles undefined aliases gracefully', () => {
    const { ghsaId, cveId } = extractAliases({ id: 'GO-2023-1234' });
    expect(ghsaId).toBe('GO-2023-1234');
    expect(cveId).toBeNull();
  });
});
