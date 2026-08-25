import semver from 'semver';
import { PolicyType, Severity } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  type: PolicyType;
  severity: Severity;
  message: string;
  affectedPackages: string[];
}

// Severity ranking: CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN
const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  UNKNOWN: 1,
};

function severityGte(a: Severity, b: Severity): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
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

// Validates a DEPENDENCY_MIN_VERSION rule payload at the API boundary (create/update),
// so a non-semver floor is rejected before it can silently disable the policy at
// evaluation time (see isDependencyMinVersionRule / the `!semver.valid` guard below).
// Returns an error message string, or null when the rule is valid.
export function validateDependencyMinVersionRule(rule: unknown): string | null {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return 'rule must be an object';
  }
  const { package: pkg, minVersion } = rule as Record<string, unknown>;
  if (typeof pkg !== 'string' || !pkg.trim()) {
    return 'package is required';
  }
  if (typeof minVersion !== 'string' || !semver.valid(minVersion)) {
    return 'minVersion must be a valid semver version';
  }
  return null;
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
        repo: { userId },
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
