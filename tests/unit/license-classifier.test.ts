import { describe, it, expect } from 'vitest';
import {
  COPYLEFT_LICENSES,
  NEEDS_REVIEW_LICENSES,
  classifyLicense,
  type LicenseClassification,
} from '@/lib/license/classifier';
import { classifyJavaLicense } from '@/lib/license/java';
import { classifyPythonLicense } from '@/lib/license/python';
import { classifyRustLicense } from '@/lib/license/rust';

const COMPATIBLE: LicenseClassification = { isCompatible: true, policyViolation: false, needsReview: false };
const VIOLATION: LicenseClassification = { isCompatible: false, policyViolation: true, needsReview: false };
const REVIEW: LicenseClassification = { isCompatible: true, policyViolation: false, needsReview: true };

// npm (detector.ts) and PHP (php.ts) hand the registry string straight to the
// shared classifier; Java, Python and Rust prepare it first.
const ecosystems: Record<string, (license: string) => LicenseClassification> = {
  npm: classifyLicense,
  php: classifyLicense,
  java: classifyJavaLicense,
  python: classifyPythonLicense,
  rust: classifyRustLicense,
};

// Ids every ecosystem must classify identically.
const sharedRows: Array<[string, LicenseClassification]> = [
  ['MIT', COMPATIBLE],
  ['Apache-2.0', COMPATIBLE],
  ['BSD-3-Clause', COMPATIBLE],
  ['CC0-1.0', COMPATIBLE],
  ['GPL-2.0', VIOLATION],
  ['GPL-3.0-or-later', VIOLATION],
  ['AGPL-3.0', VIOLATION],
  ['LGPL-2.1', VIOLATION],
  ['MPL-2.0', VIOLATION],
  ['EPL-2.0', VIOLATION],
  ['gpl-3.0', VIOLATION],
  ['  mit  ', COMPATIBLE],
  ['UNKNOWN', REVIEW],
  ['', REVIEW],
  ['UNLICENSED', REVIEW],
  ['unlicensed', REVIEW],
  ['SEE LICENSE IN LICENSE', REVIEW],
];

describe('shared license classification across ecosystems', () => {
  for (const [ecosystem, classify] of Object.entries(ecosystems)) {
    describe(ecosystem, () => {
      for (const [id, expected] of sharedRows) {
        it(`classifies ${JSON.stringify(id)}`, () => {
          expect(classify(id)).toEqual(expected);
        });
      }
    });
  }
});

describe('ecosystem-specific preparation runs before the shared classifier', () => {
  const rows: Array<[string, (license: string) => LicenseClassification, string, LicenseClassification]> = [
    ['java full name (GPL)', classifyJavaLicense, 'GNU General Public License v2.0', VIOLATION],
    ['java full name (EPL)', classifyJavaLicense, 'Eclipse Public License - v 1.0', VIOLATION],
    ['java full name (permissive)', classifyJavaLicense, 'The Apache Software License, Version 2.0', COMPATIBLE],
    ['python free text (GPLv3)', classifyPythonLicense, 'GNU General Public License v3 (GPLv3)', VIOLATION],
    ['python free text (MIT)', classifyPythonLicense, 'MIT License', COMPATIBLE],
    ['python free text (empty)', classifyPythonLicense, '   ', REVIEW],
    ['rust dual license picks the permissive part', classifyRustLicense, 'GPL-3.0 OR MIT', COMPATIBLE],
    ['rust dual license with no ranked part keeps the first', classifyRustLicense, 'GPL-3.0 OR LGPL-3.0', VIOLATION],
  ];
  for (const [name, classify, input, expected] of rows) {
    it(name, () => {
      expect(classify(input)).toEqual(expected);
    });
  }

  it('non-Java ecosystems do not substring-match full names', () => {
    expect(classifyLicense('GNU General Public License v2.0')).toEqual(COMPATIBLE);
    expect(classifyRustLicense('GNU General Public License v2.0')).toEqual(COMPATIBLE);
  });
});

describe('shared lists', () => {
  it('holds exactly the 20 copyleft ids', () => {
    expect([...COPYLEFT_LICENSES].sort()).toEqual(
      [
        'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
        'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
        'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
        'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0',
        'MPL-2.0', 'EUPL-1.1', 'EUPL-1.2',
        'CDDL-1.0', 'CDDL-1.1',
        'OSL-3.0', 'EPL-1.0', 'EPL-2.0',
      ].sort(),
    );
  });

  it('needs-review list carries UNLICENSED', () => {
    expect(NEEDS_REVIEW_LICENSES.has('UNLICENSED')).toBe(true);
  });
});
