import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the PURL generation logic
function toPurl(ecosystem: string, packageName: string, version?: string): string {
  const eco = ecosystem.toLowerCase();
  const type =
    eco === 'npm' ? 'npm' :
    eco === 'pypi' ? 'pypi' :
    eco === 'maven' ? 'maven' :
    eco === 'rubygems' ? 'gem' :
    eco === 'go' ? 'golang' : 'generic';
  const base = `pkg:${type}/${encodeURIComponent(packageName)}`;
  return version ? `${base}@${encodeURIComponent(version)}` : base;
}

function severityToCycloneDX(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    case 'LOW': return 'low';
    default: return 'unknown';
  }
}

describe('SBOM Generator', () => {
  describe('toPurl()', () => {
    it('generates npm PURL', () => {
      expect(toPurl('npm', 'express', '4.18.2')).toBe('pkg:npm/express@4.18.2');
    });

    it('generates pypi PURL', () => {
      expect(toPurl('pypi', 'requests', '2.28.0')).toBe('pkg:pypi/requests@2.28.0');
    });

    it('generates maven PURL', () => {
      expect(toPurl('maven', 'org.springframework', '5.3.0')).toBe('pkg:maven/org.springframework@5.3.0');
    });

    it('generates gem PURL for rubygems', () => {
      expect(toPurl('rubygems', 'rails', '7.0.0')).toBe('pkg:gem/rails@7.0.0');
    });

    it('generates golang PURL', () => {
      expect(toPurl('go', 'github.com/gin-gonic/gin', '1.9.0')).toBe(
        'pkg:golang/github.com%2Fgin-gonic%2Fgin@1.9.0'
      );
    });

    it('generates generic PURL for unknown ecosystem', () => {
      expect(toPurl('unknown', 'somelib', '1.0.0')).toBe('pkg:generic/somelib@1.0.0');
    });

    it('omits version when not provided', () => {
      expect(toPurl('npm', 'express')).toBe('pkg:npm/express');
    });

    it('encodes scoped packages correctly', () => {
      expect(toPurl('npm', '@types/node', '18.0.0')).toBe('pkg:npm/%40types%2Fnode@18.0.0');
    });
  });

  describe('severityToCycloneDX()', () => {
    it('maps CRITICAL to critical', () => expect(severityToCycloneDX('CRITICAL')).toBe('critical'));
    it('maps HIGH to high', () => expect(severityToCycloneDX('HIGH')).toBe('high'));
    it('maps MEDIUM to medium', () => expect(severityToCycloneDX('MEDIUM')).toBe('medium'));
    it('maps LOW to low', () => expect(severityToCycloneDX('LOW')).toBe('low'));
    it('maps unknown to unknown', () => expect(severityToCycloneDX('UNKNOWN')).toBe('unknown'));
    it('is case-insensitive', () => expect(severityToCycloneDX('critical')).toBe('critical'));
  });
});
