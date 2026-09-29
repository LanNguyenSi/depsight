// Single license classifier shared by every ecosystem that classifies licenses.
// Ecosystem-specific preparation of the raw string (Java full-name matching,
// PyPI free-text normalization, Rust dual-license reduction) stays in the
// ecosystem files and runs before classifyLicense.

export interface LicenseClassification {
  isCompatible: boolean;
  policyViolation: boolean;
  needsReview: boolean;
}

// Copyleft licenses that conflict with proprietary use
export const COPYLEFT_LICENSES = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0',
  'MPL-2.0', 'EUPL-1.1', 'EUPL-1.2',
  'CDDL-1.0', 'CDDL-1.1',
  'OSL-3.0', 'EPL-1.0', 'EPL-2.0',
]) as ReadonlySet<string>;

// Unknown or custom licenses: not a violation, but they need manual review.
// Compared against the trimmed, upper-cased input ('' is the empty string).
export const NEEDS_REVIEW_LICENSES: ReadonlySet<string> = new Set([
  'UNKNOWN',
  '',
  'SEE LICENSE IN LICENSE',
  'UNLICENSED',
]);

const COPYLEFT_UPPER: ReadonlySet<string> = new Set(
  [...COPYLEFT_LICENSES].map((l) => l.toUpperCase()),
);

/** The classification of any copyleft license (a policy violation). */
export const COPYLEFT_CLASSIFICATION: LicenseClassification = Object.freeze({
  isCompatible: false,
  policyViolation: true,
  needsReview: false,
});

export function classifyLicense(license: string): LicenseClassification {
  const normalized = license.trim().toUpperCase();

  if (COPYLEFT_UPPER.has(normalized)) {
    return { ...COPYLEFT_CLASSIFICATION };
  }

  if (NEEDS_REVIEW_LICENSES.has(normalized)) {
    return { isCompatible: true, policyViolation: false, needsReview: true };
  }

  return { isCompatible: true, policyViolation: false, needsReview: false };
}
