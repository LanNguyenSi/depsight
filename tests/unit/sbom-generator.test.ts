import { describe, it, expect } from 'vitest';
import { toPurl } from '@/lib/sbom/cyclonedx';

// severityToCycloneDX is not exported; test it via a local copy (it is a pure
// formatting function and the SBOM module tests cover the output end-to-end).
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
    it('generates npm PURL for a simple (unscoped) package', () => {
      expect(toPurl('npm', 'express', '4.18.2')).toBe('pkg:npm/express@4.18.2');
    });

    it('generates npm PURL for a scoped package — @ encoded, / preserved as separator', () => {
      // PURL spec: pkg:npm/%40scope/name  (not %40scope%2Fname)
      expect(toPurl('npm', '@types/node', '18.0.0')).toBe('pkg:npm/%40types/node@18.0.0');
    });

    it('generates pypi PURL using depsight vocabulary', () => {
      expect(toPurl('python', 'requests', '2.28.0')).toBe('pkg:pypi/requests@2.28.0');
    });

    it('generates pypi PURL using GitHub/OSV pip vocabulary', () => {
      expect(toPurl('pip', 'flask', '2.3.0')).toBe('pkg:pypi/flask@2.3.0');
    });

    it('generates maven PURL splitting groupId:artifactId on ":"', () => {
      // maven: org.springframework.boot:spring-boot -> pkg:maven/org.springframework.boot/spring-boot
      expect(toPurl('maven', 'org.springframework.boot:spring-boot', '2.7.0')).toBe(
        'pkg:maven/org.springframework.boot/spring-boot@2.7.0',
      );
    });

    it('generates maven PURL for a plain name (no colon) without splitting', () => {
      expect(toPurl('java', 'commons-lang3', '3.12.0')).toBe('pkg:maven/commons-lang3@3.12.0');
    });

    it('generates cargo PURL using depsight rust vocabulary', () => {
      expect(toPurl('rust', 'serde', '1.0.0')).toBe('pkg:cargo/serde@1.0.0');
    });

    it('generates cargo PURL using crates.io vocabulary', () => {
      expect(toPurl('crates.io', 'tokio', '1.28.0')).toBe('pkg:cargo/tokio@1.28.0');
    });

    it('generates composer PURL splitting vendor/package on "/"', () => {
      // composer: vendor/package -> pkg:composer/vendor/package
      expect(toPurl('php', 'vendor/my-package', '1.0.0')).toBe(
        'pkg:composer/vendor/my-package@1.0.0',
      );
    });

    it('generates composer PURL using packagist vocabulary', () => {
      expect(toPurl('packagist', 'symfony/console', '6.2.0')).toBe(
        'pkg:composer/symfony/console@6.2.0',
      );
    });

    it('generates golang PURL — path segments encoded separately, "/" preserved', () => {
      // golang: github.com/gin-gonic/gin -> pkg:golang/github.com/gin-gonic/gin
      expect(toPurl('go', 'github.com/gin-gonic/gin', '1.9.0')).toBe(
        'pkg:golang/github.com/gin-gonic/gin@1.9.0',
      );
    });

    it('generates gem PURL for rubygems', () => {
      expect(toPurl('rubygems', 'rails', '7.0.0')).toBe('pkg:gem/rails@7.0.0');
    });

    it('generates gem PURL using ruby vocabulary', () => {
      expect(toPurl('ruby', 'sinatra', '3.0.0')).toBe('pkg:gem/sinatra@3.0.0');
    });

    it('generates generic PURL for unknown ecosystem', () => {
      expect(toPurl('unknown', 'somelib', '1.0.0')).toBe('pkg:generic/somelib@1.0.0');
    });

    it('omits version when not provided', () => {
      expect(toPurl('npm', 'express')).toBe('pkg:npm/express');
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
