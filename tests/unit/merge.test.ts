import { describe, it, expect } from 'vitest';
import { mergeCveAdvisories } from '@/lib/cve/merge';
import type { GitHubAdvisory } from '@/lib/cve/github-advisories';

function makeAdvisory(
  overrides: Partial<GitHubAdvisory> & { ghsaId: string; packageName: string },
): GitHubAdvisory {
  return {
    cveId: null,
    severity: 'HIGH',
    summary: 'Test advisory',
    ecosystem: 'npm',
    vulnerableRange: null,
    fixedVersion: null,
    publishedAt: null,
    url: null,
    source: 'dependabot',
    ...overrides,
  };
}

describe('mergeCveAdvisories()', () => {
  it('(a) drops OSV advisory when it shares ghsaId+packageName with Dependabot', () => {
    const dep = makeAdvisory({ ghsaId: 'GHSA-aaaa-bbbb-cccc', packageName: 'lodash', source: 'dependabot' });
    const osv = makeAdvisory({ ghsaId: 'GHSA-aaaa-bbbb-cccc', packageName: 'lodash', source: 'osv' });
    const result = mergeCveAdvisories([dep], [osv]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('dependabot');
  });

  it('(b) drops OSV advisory when it shares cveId+packageName with Dependabot', () => {
    const dep = makeAdvisory({
      ghsaId: 'GHSA-aaaa-bbbb-1111',
      cveId: 'CVE-2023-12345',
      packageName: 'express',
      source: 'dependabot',
    });
    // OSV has a different ghsaId (alias) but same cveId+package
    const osv = makeAdvisory({
      ghsaId: 'GHSA-aaaa-bbbb-2222',
      cveId: 'CVE-2023-12345',
      packageName: 'express',
      source: 'osv',
    });
    const result = mergeCveAdvisories([dep], [osv]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('dependabot');
  });

  it('(c) KEEPS OSV advisory when ghsaId matches Dependabot but package is DIFFERENT', () => {
    const dep = makeAdvisory({
      ghsaId: 'GHSA-aaaa-bbbb-cccc',
      packageName: 'lodash',
      source: 'dependabot',
    });
    // Same GHSA ID, different package — independent finding, must be kept
    const osv = makeAdvisory({
      ghsaId: 'GHSA-aaaa-bbbb-cccc',
      packageName: 'lodash-es',
      source: 'osv',
    });
    const result = mergeCveAdvisories([dep], [osv]);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.packageName)).toContain('lodash-es');
  });

  it('(d) intra-OSV alias pair collapses to the GHSA-bearing record', () => {
    // Two OSV advisories for the same CVE + package: one GHSA-bearing, one PYSEC alias
    const ghsaRecord = makeAdvisory({
      ghsaId: 'GHSA-xxxx-yyyy-zzzz',
      cveId: 'CVE-2023-99999',
      packageName: 'requests',
      source: 'osv',
    });
    const aliasRecord = makeAdvisory({
      ghsaId: 'PYSEC-2023-100',
      cveId: 'CVE-2023-99999',
      packageName: 'requests',
      source: 'osv',
    });
    const result = mergeCveAdvisories([], [aliasRecord, ghsaRecord]);
    // Only one should survive; it must be the GHSA-bearing one
    expect(result).toHaveLength(1);
    expect(result[0].ghsaId).toBe('GHSA-xxxx-yyyy-zzzz');
  });

  it('(e) null cveId does not create spurious matches between different advisories', () => {
    const dep = makeAdvisory({ ghsaId: 'GHSA-1111-2222-3333', cveId: null, packageName: 'axios', source: 'dependabot' });
    const osv = makeAdvisory({ ghsaId: 'GHSA-4444-5555-6666', cveId: null, packageName: 'axios', source: 'osv' });
    const result = mergeCveAdvisories([dep], [osv]);
    // Different GHSA, both cveId null — no spurious match, OSV should be kept
    expect(result).toHaveLength(2);
  });

  it('(f) OSV-only (no overlap with Dependabot) advisories are all kept', () => {
    const osv1 = makeAdvisory({ ghsaId: 'GHSA-aaaa-0001-0001', packageName: 'pkg-a', source: 'osv' });
    const osv2 = makeAdvisory({ ghsaId: 'GHSA-aaaa-0002-0002', packageName: 'pkg-b', source: 'osv' });
    const result = mergeCveAdvisories([], [osv1, osv2]);
    expect(result).toHaveLength(2);
  });

  it('returns all dependabot advisories even when no OSV advisories are provided', () => {
    const dep1 = makeAdvisory({ ghsaId: 'GHSA-aaaa-1111-aaaa', packageName: 'react', source: 'dependabot' });
    const dep2 = makeAdvisory({ ghsaId: 'GHSA-bbbb-2222-bbbb', packageName: 'react-dom', source: 'dependabot' });
    const result = mergeCveAdvisories([dep1, dep2], []);
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.source === 'dependabot')).toBe(true);
  });

  it('preserves dependabot advisory ordering: dependabot rows come first', () => {
    const dep = makeAdvisory({ ghsaId: 'GHSA-dep-0000-0000', packageName: 'dep-pkg', source: 'dependabot' });
    const osv = makeAdvisory({ ghsaId: 'GHSA-osv-1111-1111', packageName: 'osv-pkg', source: 'osv' });
    const result = mergeCveAdvisories([dep], [osv]);
    expect(result[0].source).toBe('dependabot');
    expect(result[1].source).toBe('osv');
  });
});
