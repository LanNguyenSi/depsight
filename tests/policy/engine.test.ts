/**
 * Unit tests for lib/policy/engine.ts — evaluatePolicies()
 * Mocks Prisma to test all 4 PolicyTypes in isolation.
 */

import { PolicyType, Severity } from '@prisma/client';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPolicyFindMany = jest.fn();
const mockScanFindFirst = jest.fn();

jest.mock('@/lib/prisma', () => ({
  prisma: {
    policy: {
      findMany: mockPolicyFindMany,
    },
    scan: {
      findFirst: mockScanFindFirst,
    },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePolicy(
  overrides: Partial<{
    id: string;
    name: string;
    type: PolicyType;
    severity: Severity;
    rule: Record<string, unknown>;
    enabled: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? 'policy-1',
    userId: 'user-1',
    name: overrides.name ?? 'Test Policy',
    type: overrides.type ?? PolicyType.LICENSE_DENY,
    severity: overrides.severity ?? Severity.HIGH,
    rule: overrides.rule ?? {},
    enabled: overrides.enabled ?? true,
    createdAt: new Date(),
  };
}

function makeScan(overrides: Partial<{
  licenses: { id: string; packageName: string; version: string | null; license: string; isCompatible: boolean; policyViolation: boolean }[];
  advisories: { id: string; packageName: string; ghsaId: string; severity: Severity }[];
  dependencies: { id: string; name: string; installedVersion: string; ageInDays: number | null }[];
}> = {}) {
  return {
    id: 'scan-1',
    repoId: 'repo-1',
    licenses: overrides.licenses ?? [],
    advisories: overrides.advisories ?? [],
    dependencies: overrides.dependencies ?? [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluatePolicies()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('LICENSE_DENY — catches denied license', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.LICENSE_DENY,
        rule: { deniedLicenses: ['GPL-2.0', 'GPL-3.0'] },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        licenses: [
          { id: 'l1', packageName: 'badpkg', version: '1.0.0', license: 'GPL-2.0', isCompatible: false, policyViolation: false },
          { id: 'l2', packageName: 'goodpkg', version: '2.0.0', license: 'MIT', isCompatible: true, policyViolation: false },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe(PolicyType.LICENSE_DENY);
    expect(violations[0].affectedPackages).toHaveLength(1);
    expect(violations[0].affectedPackages[0]).toContain('badpkg');
    expect(violations[0].affectedPackages[0]).toContain('GPL-2.0');
  });

  it('LICENSE_ALLOW_ONLY — catches unlisted license', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.LICENSE_ALLOW_ONLY,
        rule: { allowedLicenses: ['MIT', 'Apache-2.0'] },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        licenses: [
          { id: 'l1', packageName: 'okpkg', version: '1.0.0', license: 'MIT', isCompatible: true, policyViolation: false },
          { id: 'l2', packageName: 'strictpkg', version: '1.0.0', license: 'GPL-3.0', isCompatible: false, policyViolation: false },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe(PolicyType.LICENSE_ALLOW_ONLY);
    expect(violations[0].affectedPackages).toHaveLength(1);
    expect(violations[0].affectedPackages[0]).toContain('strictpkg');
  });

  it('CVE_MIN_SEVERITY — catches severity violations', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.CVE_MIN_SEVERITY,
        severity: Severity.CRITICAL,
        rule: { minSeverity: 'HIGH' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        advisories: [
          { id: 'a1', packageName: 'vulnpkg', ghsaId: 'GHSA-1111-1111-1111', severity: Severity.CRITICAL },
          { id: 'a2', packageName: 'highpkg', ghsaId: 'GHSA-2222-2222-2222', severity: Severity.HIGH },
          { id: 'a3', packageName: 'lowpkg', ghsaId: 'GHSA-3333-3333-3333', severity: Severity.LOW },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe(PolicyType.CVE_MIN_SEVERITY);
    // CRITICAL and HIGH both >= HIGH → 2 affected
    expect(violations[0].affectedPackages).toHaveLength(2);
    expect(violations[0].affectedPackages.some((p) => p.includes('vulnpkg'))).toBe(true);
    expect(violations[0].affectedPackages.some((p) => p.includes('highpkg'))).toBe(true);
  });

  it('DEPENDENCY_MAX_AGE — catches old dependencies', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MAX_AGE,
        rule: { maxAgeDays: 365 },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'oldpkg', installedVersion: '1.0.0', ageInDays: 800 },
          { id: 'd2', name: 'newpkg', installedVersion: '2.0.0', ageInDays: 100 },
          { id: 'd3', name: 'unknownpkg', installedVersion: '1.0.0', ageInDays: -1 },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe(PolicyType.DEPENDENCY_MAX_AGE);
    expect(violations[0].affectedPackages).toHaveLength(1);
    expect(violations[0].affectedPackages[0]).toContain('oldpkg');
  });

  it('disabled policies are skipped', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.LICENSE_DENY,
        rule: { deniedLicenses: ['GPL-2.0'] },
        enabled: false,
      }),
    ]);
    // Note: findMany is filtered by enabled:true in the engine, so mock returns empty
    mockPolicyFindMany.mockResolvedValue([]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        licenses: [
          { id: 'l1', packageName: 'badpkg', version: '1.0.0', license: 'GPL-2.0', isCompatible: false, policyViolation: false },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(0);
  });

  it('returns empty array when no violations', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.LICENSE_DENY,
        rule: { deniedLicenses: ['GPL-2.0'] },
      }),
      makePolicy({
        id: 'policy-2',
        type: PolicyType.CVE_MIN_SEVERITY,
        rule: { minSeverity: 'CRITICAL' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        licenses: [
          { id: 'l1', packageName: 'okpkg', version: '1.0.0', license: 'MIT', isCompatible: true, policyViolation: false },
        ],
        advisories: [
          { id: 'a1', packageName: 'lowvuln', ghsaId: 'GHSA-9999-9999-9999', severity: Severity.LOW },
        ],
        dependencies: [],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(0);
  });
});
