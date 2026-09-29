import semver from 'semver';
import { Prisma, PolicyType, Severity } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SEVERITY_RANK, severityGte } from '@/lib/severity';

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  type: PolicyType;
  severity: Severity;
  message: string;
  affectedPackages: string[];
}

// Type guards for rule shapes
function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((v) => typeof v === 'string');
}

function isSeverity(val: unknown): val is Severity {
  return typeof val === 'string' && Object.keys(SEVERITY_RANK).includes(val);
}

function isNumber(val: unknown): val is number {
  return typeof val === 'number';
}

function isDependencyMinVersionRule(
  val: unknown,
): val is { package: string; minVersion: string } {
  if (typeof val !== 'object' || val === null) return false;
  const { package: pkg, minVersion } = val as Record<string, unknown>;
  return typeof pkg === 'string' && pkg.length > 0 && typeof minVersion === 'string' && minVersion.length > 0;
}

export interface DependencyMinVersionRule {
  package: string;
  minVersion: string;
}

export type DependencyMinVersionRuleValidation =
  | { error: string; rule?: undefined }
  | { error?: undefined; rule: DependencyMinVersionRule };

// `String.prototype.trim()` removes ASCII whitespace and the Unicode space
// separators (including NBSP U+00A0 and ideographic space U+3000), but not
// zero-width characters: zero-width space/non-joiner/joiner (U+200B-U+200D)
// and the zero-width no-break space / BOM (U+FEFF). Those are invisible in
// any UI a caller copy-pasted the name from, so left unchecked they slip
// through into storage and never match the evaluator's exact
// `d.name === targetPackage` comparison against a real (zero-width-free)
// installed dependency name — the same "policy reports clean forever"
// failure mode trimming was added to close, just via a character class
// trim() doesn't cover.
// Written as explicit \u escapes rather than literal invisible characters,
// so the class itself isn't made of the very characters it's meant to catch.
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;

// npm package name grammar (lowercase only; a segment's first character
// cannot be `.`, `_`, or a symbol — npm disallows a leading dot or
// underscore). Verified against real package shapes: unscoped
// (`postcss`), dotted (`lodash.merge`), underscored (`left_pad`), hyphenated
// (`is-number`), scoped (`@babel/core`), and a hyphenated scope with a
// hyphenated name (`@size-limit/preset-app`) all match; `PostCSS` does not
// (uppercase). npm package names are always lowercase, so a mixed-case name
// passes every other check here but never matches an installed dependency's
// real (lowercase) name at evaluation time — again the same failure mode.
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// Validates a DEPENDENCY_MIN_VERSION rule payload at the API boundary (create/update),
// so a non-semver floor is rejected before it can silently disable the policy at
// evaluation time (see isDependencyMinVersionRule / the `!semver.valid` guard below).
// Also normalizes `package` (trims it) and returns that normalized rule: the
// evaluator matches installs with a strict `d.name === targetPackage` (see
// evaluatePolicies below), so a padded package name that made it into storage
// untrimmed would never match anything and the policy would report clean
// forever. Persisting the trimmed value here makes that failure mode
// impossible regardless of what any particular client does.
//
// Beyond trimming, a name is rejected outright (not silently cleaned) when
// it carries zero-width characters or is not valid lowercase npm grammar
// (see the two constants above): silently stripping or lowercasing it here
// would still leave the caller with a policy that looks accepted but can
// never match anything, which is the same silently-broken-policy outcome
// this whole function exists to prevent. Better to fail the request loudly.
//
// The "rule must be an object" branch is normally unreachable: validatePolicyRule
// (the caller for the API routes) checks the object shape before dispatching
// per type, and both routes reject a non-object `rule` from the request body
// first. It stays as a defensive guard for direct callers that pass a value
// read back from storage.
export function validateDependencyMinVersionRule(rule: unknown): DependencyMinVersionRuleValidation {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return { error: 'rule must be an object' };
  }
  const { package: pkg, minVersion } = rule as Record<string, unknown>;
  if (typeof pkg !== 'string' || !pkg.trim()) {
    return { error: 'package is required' };
  }
  const trimmedPkg = pkg.trim();
  if (trimmedPkg.replace(ZERO_WIDTH_RE, '') !== trimmedPkg) {
    return { error: 'package must not contain invisible characters' };
  }
  if (!NPM_PACKAGE_NAME_RE.test(trimmedPkg)) {
    return { error: 'package must be a valid npm package name' };
  }
  if (typeof minVersion !== 'string' || !semver.valid(minVersion)) {
    return { error: 'minVersion must be a valid semver version' };
  }
  return { rule: { package: trimmedPkg, minVersion } };
}

export type PolicyRuleValidation =
  | { error: string; rule?: undefined }
  | { error?: undefined; rule: Prisma.InputJsonValue };

// Validates a rule payload against the shape its PolicyType evaluates, using the
// same guards evaluatePolicies applies. This runs on every policy write (create
// and update) and on stored rows during evaluation, so a rule that would fall
// out of its evaluation case without a violation is rejected up front instead
// of persisting and reporting clean forever. The returned rule is the value to
// persist (DEPENDENCY_MIN_VERSION normalizes the package name; the other types
// return the rule unchanged).
export function validatePolicyRule(type: PolicyType, rule: unknown): PolicyRuleValidation {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return { error: 'rule must be an object' };
  }
  const fields = rule as Record<string, unknown>;
  const persisted = rule as Prisma.InputJsonValue;

  switch (type) {
    case PolicyType.LICENSE_DENY:
      if (!isStringArray(fields['deniedLicenses'])) {
        return { error: 'rule.deniedLicenses must be an array of strings' };
      }
      return { rule: persisted };
    case PolicyType.LICENSE_ALLOW_ONLY:
      if (!isStringArray(fields['allowedLicenses'])) {
        return { error: 'rule.allowedLicenses must be an array of strings' };
      }
      return { rule: persisted };
    case PolicyType.CVE_MIN_SEVERITY:
      if (!isSeverity(fields['minSeverity'])) {
        return {
          error: `rule.minSeverity must be one of ${Object.keys(SEVERITY_RANK).join(', ')}`,
        };
      }
      return { rule: persisted };
    case PolicyType.DEPENDENCY_MAX_AGE:
      if (!Number.isFinite(fields['maxAgeDays'])) {
        return { error: 'rule.maxAgeDays must be a number' };
      }
      return { rule: persisted };
    case PolicyType.DEPENDENCY_MIN_VERSION: {
      const result = validateDependencyMinVersionRule(rule);
      if (result.error) return { error: result.error };
      return { rule: result.rule as unknown as Prisma.InputJsonValue };
    }
    default:
      return { error: 'invalid type' };
  }
}

export async function evaluatePolicies(
  userId: string,
  scanId: string,
): Promise<PolicyViolation[]> {
  const [policies, scan] = await Promise.all([
    prisma.policy.findMany({
      where: { userId, enabled: true },
    }),
    prisma.scan.findFirst({
      where: {
        id: scanId,
        repo: { userId, tracked: true },
      },
      include: {
        licenses: true,
        advisories: true,
        dependencies: true,
      },
    }),
  ]);

  if (!scan) {
    throw new Error(`Scan ${scanId} not found or not owned by user ${userId}`);
  }

  const violations: PolicyViolation[] = [];

  for (const policy of policies) {
    const rule = policy.rule as Record<string, unknown>;

    // Rows stored before write-time validation existed (or written outside the
    // API) can carry a rule that falls out of its case below without a
    // violation. Surface each such row on every evaluation instead of letting it
    // report clean silently. Evaluation itself is unchanged.
    const stored = validatePolicyRule(policy.type, policy.rule);
    if (stored.error) {
      console.warn(
        `[policy] ${policy.type} policy "${policy.name}" (${policy.id}) has a malformed rule and may never match: ${stored.error}`,
      );
    }

    switch (policy.type) {
      case PolicyType.LICENSE_DENY: {
        const deniedLicenses = rule['deniedLicenses'];
        if (!isStringArray(deniedLicenses)) break;

        const affected = scan.licenses
          .filter((l) => deniedLicenses.includes(l.license))
          .map((l) => `${l.packageName}${l.version ? `@${l.version}` : ''} (${l.license})`);

        if (affected.length > 0) {
          violations.push({
            policyId: policy.id,
            policyName: policy.name,
            type: policy.type,
            severity: policy.severity,
            message: `${affected.length} Paket(e) verwenden verbotene Lizenzen: ${deniedLicenses.join(', ')}`,
            affectedPackages: affected,
          });
        }
        break;
      }

      case PolicyType.LICENSE_ALLOW_ONLY: {
        const allowedLicenses = rule['allowedLicenses'];
        if (!isStringArray(allowedLicenses)) break;

        const affected = scan.licenses
          .filter((l) => !allowedLicenses.includes(l.license))
          .map((l) => `${l.packageName}${l.version ? `@${l.version}` : ''} (${l.license})`);

        if (affected.length > 0) {
          violations.push({
            policyId: policy.id,
            policyName: policy.name,
            type: policy.type,
            severity: policy.severity,
            message: `${affected.length} Paket(e) verwenden Lizenzen außerhalb der Allowlist`,
            affectedPackages: affected,
          });
        }
        break;
      }

      case PolicyType.CVE_MIN_SEVERITY: {
        const minSeverity = rule['minSeverity'];
        if (!isSeverity(minSeverity)) break;

        const affected = scan.advisories
          .filter((a) => severityGte(a.severity, minSeverity))
          .map((a) => `${a.packageName} (${a.ghsaId}, ${a.severity})`);

        if (affected.length > 0) {
          violations.push({
            policyId: policy.id,
            policyName: policy.name,
            type: policy.type,
            severity: policy.severity,
            message: `${affected.length} CVE(s) mit Severity >= ${minSeverity} gefunden`,
            affectedPackages: affected,
          });
        }
        break;
      }

      case PolicyType.DEPENDENCY_MAX_AGE: {
        const maxAgeDays = rule['maxAgeDays'];
        if (!isNumber(maxAgeDays)) break;

        const affected = scan.dependencies
          .filter((d) => d.ageInDays !== null && d.ageInDays !== -1 && d.ageInDays > maxAgeDays)
          .map((d) => `${d.name}@${d.installedVersion} (${d.ageInDays} Tage alt)`);

        if (affected.length > 0) {
          violations.push({
            policyId: policy.id,
            policyName: policy.name,
            type: policy.type,
            severity: policy.severity,
            message: `${affected.length} Abhängigkeit(en) älter als ${maxAgeDays} Tage`,
            affectedPackages: affected,
          });
        }
        break;
      }

      case PolicyType.DEPENDENCY_MIN_VERSION: {
        if (!isDependencyMinVersionRule(rule)) break;
        const { package: targetPackage, minVersion } = rule;
        if (!semver.valid(minVersion)) break;

        const matching = scan.dependencies.filter((d) => d.name === targetPackage);

        const affected: string[] = [];
        let unparseableCount = 0;

        for (const dep of matching) {
          if (!semver.valid(dep.installedVersion)) {
            unparseableCount += 1;
            continue;
          }
          if (semver.lt(dep.installedVersion, minVersion)) {
            affected.push(`${dep.name}@${dep.installedVersion} (Mindestversion: ${minVersion})`);
          }
        }

        if (unparseableCount > 0) {
          // Visible even when affected.length is 0: a policy that skips every
          // installed version because it can't be parsed as semver still reports
          // clean, and that must not happen without a trace.
          console.warn(
            `[policy] DEPENDENCY_MIN_VERSION policy "${policy.name}" (${policy.id}) skipped ${unparseableCount} unparseable installed version(s) of ${targetPackage}`,
          );
        }

        if (affected.length > 0) {
          const messageParts = [
            `${affected.length} Installation(en) von ${targetPackage} unterschreiten die Mindestversion ${minVersion}`,
          ];
          if (unparseableCount > 0) {
            messageParts.push(
              `${unparseableCount} Installation(en) mit nicht auswertbarer Version übersprungen (unparseable)`,
            );
          }

          violations.push({
            policyId: policy.id,
            policyName: policy.name,
            type: policy.type,
            severity: policy.severity,
            message: messageParts.join('; '),
            affectedPackages: affected,
          });
        }
        break;
      }
    }
  }

  return violations;
}
