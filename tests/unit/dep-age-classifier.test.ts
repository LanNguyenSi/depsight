import { describe, it, expect } from 'vitest';
import type { DepStatus } from '@prisma/client';

// Extracted from lib/deps/age-checker.ts
function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^[^0-9]*/, '').split('.').map(Number);
  return [cleaned[0] ?? 0, cleaned[1] ?? 0, cleaned[2] ?? 0];
}

function classifyStatus(
  installed: string,
  latest: string,
  isDeprecated: boolean,
): DepStatus {
  if (isDeprecated) return 'DEPRECATED';
  if (!installed || installed === 'unknown' || !latest) return 'UNKNOWN';

  try {
    const [iMajor, iMinor, iPatch] = parseVersion(installed);
    const [lMajor, lMinor, lPatch] = parseVersion(latest);

    if (iMajor < lMajor) return 'MAJOR_BEHIND';
    if (iMajor === lMajor && (iMinor < lMinor || (iMinor === lMinor && iPatch < lPatch))) {
      return 'OUTDATED';
    }
    return 'UP_TO_DATE';
  } catch {
    return 'UNKNOWN';
  }
}

describe('Dependency Age Classifier', () => {
  describe('classifyStatus', () => {
    it('returns UP_TO_DATE when versions match', () => {
      expect(classifyStatus('1.2.3', '1.2.3', false)).toBe('UP_TO_DATE');
    });

    it('returns OUTDATED for minor version behind', () => {
      expect(classifyStatus('1.2.0', '1.3.0', false)).toBe('OUTDATED');
    });

    it('returns OUTDATED for patch version behind', () => {
      expect(classifyStatus('1.2.3', '1.2.9', false)).toBe('OUTDATED');
    });

    it('returns MAJOR_BEHIND for major version behind', () => {
      expect(classifyStatus('1.9.9', '2.0.0', false)).toBe('MAJOR_BEHIND');
    });

    it('returns DEPRECATED when package is deprecated', () => {
      expect(classifyStatus('1.0.0', '2.0.0', true)).toBe('DEPRECATED');
    });

    it('returns UNKNOWN when installed version is empty', () => {
      expect(classifyStatus('', '1.0.0', false)).toBe('UNKNOWN');
    });

    it('returns UNKNOWN when latest version is empty', () => {
      expect(classifyStatus('1.0.0', '', false)).toBe('UNKNOWN');
    });

    it('handles version strings with ^ or ~ prefix', () => {
      expect(classifyStatus('^1.2.3', '1.2.3', false)).toBe('UP_TO_DATE');
      expect(classifyStatus('~1.2.0', '1.2.9', false)).toBe('OUTDATED');
    });
  });

  describe('parseVersion', () => {
    it('parses standard semver', () => {
      expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    });

    it('parses version with ^ prefix', () => {
      expect(parseVersion('^2.5.0')).toEqual([2, 5, 0]);
    });

    it('handles incomplete versions', () => {
      expect(parseVersion('1.0')).toEqual([1, 0, 0]);
    });
  });
});
