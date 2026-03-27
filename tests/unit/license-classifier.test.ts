import { describe, it, expect } from 'vitest';

// Extracted logic from lib/license/detector.ts for unit testing
const COPYLEFT_LICENSES = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0',
  'MPL-2.0', 'EUPL-1.1', 'EUPL-1.2',
  'CDDL-1.0', 'CDDL-1.1',
  'OSL-3.0', 'EPL-1.0', 'EPL-2.0',
]);

function classifyLicense(license: string): {
  isCompatible: boolean;
  policyViolation: boolean;
  needsReview: boolean;
} {
  const normalized = license.trim().toUpperCase();

  for (const l of COPYLEFT_LICENSES) {
    if (normalized === l.toUpperCase()) {
      return { isCompatible: false, policyViolation: true, needsReview: false };
    }
  }

  if (
    normalized === 'UNKNOWN' ||
    normalized === '' ||
    normalized === 'SEE LICENSE IN LICENSE' ||
    normalized === 'UNLICENSED'
  ) {
    return { isCompatible: true, policyViolation: false, needsReview: true };
  }

  return { isCompatible: true, policyViolation: false, needsReview: false };
}

describe('License Classifier', () => {
  describe('Permissive licenses', () => {
    const permissive = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0'];
    for (const lic of permissive) {
      it(`classifies ${lic} as compatible`, () => {
        const result = classifyLicense(lic);
        expect(result.isCompatible).toBe(true);
        expect(result.policyViolation).toBe(false);
        expect(result.needsReview).toBe(false);
      });
    }
  });

  describe('Copyleft licenses', () => {
    const copyleft = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'MPL-2.0'];
    for (const lic of copyleft) {
      it(`flags ${lic} as policy violation`, () => {
        const result = classifyLicense(lic);
        expect(result.isCompatible).toBe(false);
        expect(result.policyViolation).toBe(true);
        expect(result.needsReview).toBe(false);
      });
    }
  });

  describe('Unknown licenses', () => {
    it('flags UNKNOWN as needsReview (not a violation)', () => {
      const result = classifyLicense('UNKNOWN');
      expect(result.isCompatible).toBe(true);
      expect(result.policyViolation).toBe(false);
      expect(result.needsReview).toBe(true);
    });

    it('flags empty string as needsReview', () => {
      const result = classifyLicense('');
      expect(result.needsReview).toBe(true);
      expect(result.policyViolation).toBe(false);
    });

    it('flags UNLICENSED as needsReview', () => {
      const result = classifyLicense('UNLICENSED');
      expect(result.needsReview).toBe(true);
      expect(result.policyViolation).toBe(false);
    });
  });

  it('is case-insensitive', () => {
    expect(classifyLicense('mit').isCompatible).toBe(true);
    expect(classifyLicense('gpl-3.0').policyViolation).toBe(true);
  });
});
