import { describe, it, expect } from 'vitest';
import type { Advisory } from '@prisma/client';
import { formatCVEComment } from '@/lib/pr/comment-formatter';

function makeAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: 'adv-1',
    scanId: 'scan-1',
    ghsaId: 'GHSA-test-1234-5678',
    cveId: 'CVE-2024-12345',
    severity: 'HIGH',
    summary: 'Test vulnerability in test-pkg',
    packageName: 'test-pkg',
    ecosystem: 'npm',
    vulnerableRange: '<1.0.0',
    fixedVersion: '1.0.0',
    publishedAt: new Date('2024-01-01'),
    url: 'https://github.com/advisories/GHSA-test-1234-5678',
    ...overrides,
  };
}

describe('PR Comment Formatter', () => {
  it('shows clean message when no new CVEs', () => {
    const comment = formatCVEComment('owner/repo', [], 5, 30);
    expect(comment).toContain('Keine neuen CVEs');
    expect(comment).toContain('Risk Score: 30/100');
    expect(comment).toContain('Gesamt: 5 CVEs');
  });

  it('includes CVE count in header for new advisories', () => {
    const advisories = [makeAdvisory(), makeAdvisory({ id: 'adv-2', severity: 'CRITICAL' })];
    const comment = formatCVEComment('owner/repo', advisories, 10, 70);
    expect(comment).toContain('2 neue CVE(s)');
    expect(comment).toContain('Risk Score');
  });

  it('includes severity breakdown in summary', () => {
    const advisories = [
      makeAdvisory({ severity: 'CRITICAL' }),
      makeAdvisory({ id: 'adv-2', severity: 'HIGH' }),
    ];
    const comment = formatCVEComment('owner/repo', advisories, 5, 80);
    expect(comment).toContain('Kritisch');
    expect(comment).toContain('Hoch');
  });

  it('includes GHSA ID for each advisory', () => {
    const comment = formatCVEComment('owner/repo', [makeAdvisory()], 1, 40);
    expect(comment).toContain('GHSA-test-1234-5678');
  });

  it('includes package name and ecosystem', () => {
    const comment = formatCVEComment('owner/repo', [makeAdvisory()], 1, 40);
    expect(comment).toContain('test-pkg');
    expect(comment).toContain('npm');
  });

  it('shows fix version when available', () => {
    const comment = formatCVEComment('owner/repo', [makeAdvisory({ fixedVersion: '2.0.0' })], 1, 40);
    expect(comment).toContain('2.0.0');
  });

  it('shows CVE ID when available', () => {
    const comment = formatCVEComment('owner/repo', [makeAdvisory({ cveId: 'CVE-2024-99999' })], 1, 40);
    expect(comment).toContain('CVE-2024-99999');
  });

  it('truncates list at 10 CVEs with overflow notice', () => {
    const advisories = Array.from({ length: 15 }, (_, i) =>
      makeAdvisory({ id: `adv-${i}`, ghsaId: `GHSA-test-${i.toString().padStart(4, '0')}-0000` })
    );
    const comment = formatCVEComment('owner/repo', advisories, 15, 75);
    expect(comment).toContain('weitere CVEs');
  });

  it('does not show overflow notice for ≤10 CVEs', () => {
    const advisories = Array.from({ length: 3 }, (_, i) =>
      makeAdvisory({ id: `adv-${i}` })
    );
    const comment = formatCVEComment('owner/repo', advisories, 3, 30);
    expect(comment).not.toContain('weitere CVEs');
  });
});
