import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  osvEcosystem,
  cvssV3BaseScore,
  mapOsvSeverity,
  extractAliases,
  extractVulnRangeInfo,
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

// ---- extractVulnRangeInfo ---------------------------------------------------

describe('extractVulnRangeInfo', () => {
  // Helpers to build minimal OsvVuln fixtures inline.
  function makeRange(introduced: string, fixed: string) {
    return {
      type: 'SEMVER',
      events: [{ introduced }, { fixed }],
    };
  }

  function makeVuln(
    id: string,
    packageName: string,
    ecosystem: string,
    ranges: ReturnType<typeof makeRange>[],
  ): OsvVuln {
    return {
      id,
      affected: [
        {
          package: { ecosystem, name: packageName },
          ranges,
        },
      ],
    };
  }

  // Core acceptance eval: multi-range advisory, version in the SECOND range.
  // glob GHSA-5j98-mcp5-4vw2: ranges [11.0.0,11.1.0) and [10.2.0,10.5.0).
  // Version 10.3.0 must match the SECOND range, not the first.
  it('multi-range: version in second range returns the second range string (core acceptance)', () => {
    const vuln = makeVuln('GHSA-5j98-mcp5-4vw2', 'glob', 'npm', [
      makeRange('11.0.0', '11.1.0'),
      makeRange('10.2.0', '10.5.0'),
    ]);
    const result = extractVulnRangeInfo(vuln, 'glob', 'npm', '10.3.0');
    expect(result.vulnerableRange).toBe('>=10.2.0 <10.5.0');
    expect(result.fixedVersion).toBe('10.5.0');
  });

  // Guard: version in the FIRST range of a multi-range advisory.
  it('multi-range: version in first range returns the first range string', () => {
    const vuln = makeVuln('GHSA-5j98-mcp5-4vw2', 'glob', 'npm', [
      makeRange('11.0.0', '11.1.0'),
      makeRange('10.2.0', '10.5.0'),
    ]);
    const result = extractVulnRangeInfo(vuln, 'glob', 'npm', '11.0.5');
    expect(result.vulnerableRange).toBe('>=11.0.0 <11.1.0');
    expect(result.fixedVersion).toBe('11.1.0');
  });

  // Real-shape regression: advisory splits ranges across TWO separate affected entries
  // (each with one range), which is the actual OSV shape for GHSA-5j98-mcp5-4vw2.
  // The old first-entry-only (.find) code would return '>=11.0.0 <11.1.0' for
  // version 10.3.0; the fixed code must return '>=10.2.0 <10.5.0'.
  it('real-shape: two affected entries each with one range — version in second entry returns second range', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-5j98-mcp5-4vw2',
      affected: [
        {
          package: { ecosystem: 'npm', name: 'glob' },
          ranges: [makeRange('11.0.0', '11.1.0')],
        },
        {
          package: { ecosystem: 'npm', name: 'glob' },
          ranges: [makeRange('10.2.0', '10.5.0')],
        },
      ],
    };
    const result = extractVulnRangeInfo(vuln, 'glob', 'npm', '10.3.0');
    expect(result.vulnerableRange).toBe('>=10.2.0 <10.5.0');
    expect(result.fixedVersion).toBe('10.5.0');
  });

  // Single-range advisory: behavior must be unchanged vs old code.
  it('single-range: returns the one range string unchanged', () => {
    const vuln = makeVuln('GHSA-single', 'lodash', 'npm', [makeRange('4.0.0', '4.17.21')]);
    const result = extractVulnRangeInfo(vuln, 'lodash', 'npm', '4.5.0');
    expect(result.vulnerableRange).toBe('>=4.0.0 <4.17.21');
    expect(result.fixedVersion).toBe('4.17.21');
  });

  // Single-range advisory, version outside range: still returns that range (fallback).
  it('single-range: version outside range returns range string via fallback', () => {
    const vuln = makeVuln('GHSA-single', 'lodash', 'npm', [makeRange('4.0.0', '4.17.21')]);
    const result = extractVulnRangeInfo(vuln, 'lodash', 'npm', '5.0.0');
    expect(result.vulnerableRange).toBe('>=4.0.0 <4.17.21');
    expect(result.fixedVersion).toBe('4.17.21');
  });

  // Ambiguous / non-coercible fallback: version "???-invalid" cannot be coerced,
  // so both ranges are returned comma-separated.
  it('non-coercible version: returns all candidate ranges joined by ", "', () => {
    const vuln = makeVuln('GHSA-ambig', 'pkg', 'npm', [
      makeRange('1.0.0', '1.5.0'),
      makeRange('2.0.0', '2.5.0'),
    ]);
    const result = extractVulnRangeInfo(vuln, 'pkg', 'npm', 'not-a-semver');
    expect(result.vulnerableRange).toBe('>=1.0.0 <1.5.0, >=2.0.0 <2.5.0');
    // different fixed versions -> sharedFixed is null
    expect(result.fixedVersion).toBeNull();
  });

  // No affected entries: returns null/null.
  it('no affected entries returns null/null', () => {
    const vuln: OsvVuln = { id: 'GHSA-empty', affected: [] };
    expect(extractVulnRangeInfo(vuln, 'pkg', 'npm', '1.0.0')).toEqual({
      vulnerableRange: null,
      fixedVersion: null,
    });
  });

  // No ranges on matched entry: returns null/null.
  it('matched entry with no ranges returns null/null', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-noranges',
      affected: [{ package: { ecosystem: 'npm', name: 'pkg' }, ranges: [] }],
    };
    expect(extractVulnRangeInfo(vuln, 'pkg', 'npm', '1.0.0')).toEqual({
      vulnerableRange: null,
      fixedVersion: null,
    });
  });

  // Interleaved intervals within a SINGLE range's events array: a range can carry
  // MULTIPLE [introduced, fixed) pairs, not just one. The queried version sits in
  // the SECOND interval; the old code (first .find() per range) would have used
  // the FIRST introduced (1.0.0) paired with the FIRST fixed (1.2.0), silently
  // discarding the second pair.
  it('interleaved: single range with two interleaved intervals — version in second interval', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-interleaved',
      affected: [
        {
          package: { ecosystem: 'npm', name: 'pkg' },
          ranges: [
            {
              type: 'SEMVER',
              events: [
                { introduced: '1.0.0' },
                { fixed: '1.2.0' },
                { introduced: '2.0.0' },
                { fixed: '2.3.0' },
              ],
            },
          ],
        },
      ],
    };
    const result = extractVulnRangeInfo(vuln, 'pkg', 'npm', '2.1.0');
    expect(result.vulnerableRange).toBe('>=2.0.0 <2.3.0');
    expect(result.fixedVersion).toBe('2.3.0');
  });

  // Same interleaved fixture, but the queried version sits in the FIRST
  // interval: guards against a regression that drops the first [introduced,
  // fixed) pair or only emits the last interval per range.
  it('interleaved: version in first interval selects the first pair', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-interleaved',
      affected: [
        {
          package: { ecosystem: 'npm', name: 'pkg' },
          ranges: [
            {
              type: 'SEMVER',
              events: [
                { introduced: '1.0.0' },
                { fixed: '1.2.0' },
                { introduced: '2.0.0' },
                { fixed: '2.3.0' },
              ],
            },
          ],
        },
      ],
    };
    const result = extractVulnRangeInfo(vuln, 'pkg', 'npm', '1.1.0');
    expect(result.vulnerableRange).toBe('>=1.0.0 <1.2.0');
    expect(result.fixedVersion).toBe('1.2.0');
  });

  // last_affected: an inclusive upper bound used when `fixed` is absent. A
  // version above last_affected must NOT be treated as a unique match (the old
  // code ignored last_affected entirely, producing an unbounded ">=2.0.0"
  // candidate that incorrectly matched versions above the true upper bound).
  describe('last_affected bound', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-lastaffected',
      affected: [
        {
          package: { ecosystem: 'npm', name: 'pkg' },
          ranges: [
            makeRange('1.0.0', '1.2.0'),
            {
              type: 'SEMVER',
              events: [{ introduced: '2.0.0' }, { last_affected: '2.5.0' }],
            },
          ],
        },
      ],
    };

    it('version at/below last_affected matches with inclusive upper bound and no fixedVersion', () => {
      const result = extractVulnRangeInfo(vuln, 'pkg', 'npm', '2.3.0');
      expect(result.vulnerableRange).toBe('>=2.0.0 <=2.5.0');
      expect(result.fixedVersion).toBeNull();
    });

    // Boundary that distinguishes last_affected (inclusive, <=) from fixed
    // (exclusive, <): the version EQUAL to last_affected must still match. A
    // lte->lt mutation of the containment check would make this case fail.
    it('version exactly at last_affected still matches (inclusive bound)', () => {
      const result = extractVulnRangeInfo(vuln, 'pkg', 'npm', '2.5.0');
      expect(result.vulnerableRange).toBe('>=2.0.0 <=2.5.0');
      expect(result.fixedVersion).toBeNull();
    });

    it('version above last_affected is not reported as a unique match', () => {
      const result = extractVulnRangeInfo(vuln, 'pkg', 'npm', '2.6.0');
      // Not uniquely matched: falls back to all candidate ranges joined, with
      // no shared fixedVersion (differs by design from the buggy old output
      // of a bare unbounded ">=2.0.0" match).
      expect(result.vulnerableRange).toBe('>=1.0.0 <1.2.0, >=2.0.0 <=2.5.0');
      expect(result.fixedVersion).toBeNull();
    });
  });
});
