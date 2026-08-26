/**
 * Unit tests for lib/policy/engine.ts — evaluatePolicies()
 * Mocks Prisma to test all 5 PolicyTypes in isolation.
 */

import { vi } from 'vitest';
import { PolicyType, Severity } from '@prisma/client';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPolicyFindMany = vi.fn();
const mockScanFindFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
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
    vi.clearAllMocks();
    vi.resetModules();
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

  it('DEPENDENCY_MIN_VERSION — catches installed version below the floor', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'postcss', installedVersion: '8.5.17', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe(PolicyType.DEPENDENCY_MIN_VERSION);
    expect(violations[0].affectedPackages).toHaveLength(1);
    expect(violations[0].affectedPackages[0]).toContain('postcss@8.5.17');
  });

  it('DEPENDENCY_MIN_VERSION — installed version at the floor is not a violation', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'postcss', installedVersion: '8.5.18', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(0);
  });

  it('DEPENDENCY_MIN_VERSION — negative control: an unrealistically high floor still reports red', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'leftpad', minVersion: '99.0.0' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'leftpad', installedVersion: '1.3.0', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].affectedPackages).toHaveLength(1);
    expect(violations[0].affectedPackages[0]).toContain('leftpad@1.3.0');
  });

  it('DEPENDENCY_MIN_VERSION — non-semver installedVersion is skipped and counted as unparseable, not reported as a violation itself', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'leftpad', minVersion: '99.0.0' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          // Genuine violation: parseable and below the floor.
          { id: 'd1', name: 'leftpad', installedVersion: '1.3.0', ageInDays: null },
          // Unparseable: not valid semver (e.g. a workspace protocol reference), must be
          // skipped and merely counted, never added to affectedPackages.
          { id: 'd2', name: 'leftpad', installedVersion: 'workspace:*', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(1);
    expect(violations[0].affectedPackages).toHaveLength(1);
    expect(violations[0].affectedPackages[0]).toContain('leftpad@1.3.0');
    expect(violations[0].affectedPackages.join(' ')).not.toContain('workspace:*');
    expect(violations[0].message).toContain('unparseable');
    expect(violations[0].message).toContain('1 Installation(en) mit nicht auswertbarer Version');
  });

  it('DEPENDENCY_MIN_VERSION — a purely unparseable installed version alone reports no violation', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'leftpad', minVersion: '1.0.0' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'leftpad', installedVersion: 'workspace:*', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(0);
  });

  it('DEPENDENCY_MIN_VERSION — an invalid (non-semver) floor reports no violation and does not throw', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'postcss', minVersion: '8.5' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'postcss', installedVersion: '1.0.0', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');

    await expect(evaluatePolicies('user-1', 'scan-1')).resolves.toEqual([]);
  });

  it('DEPENDENCY_MIN_VERSION — matches the dependency name exactly, not as a substring', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          // Name merely contains the target package name; must not be treated as a match.
          { id: 'd1', name: 'postcss-selector-parser', installedVersion: '1.0.0', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(0);
  });

  it('DEPENDENCY_MIN_VERSION — a malformed rule is skipped without throwing, and a second valid policy in the same run still reports', async () => {
    mockPolicyFindMany.mockResolvedValue([
      {
        // Built directly rather than via makePolicy(): that helper's
        // `overrides.rule ?? {}` default would silently turn a `null` rule
        // back into `{}`, which the separate `!semver.valid(minVersion)`
        // guard already catches on its own (minVersion would be undefined)
        // and would not isolate the isDependencyMinVersionRule guard's
        // removal. A rule that is not even an object is what does that:
        // destructuring `{package, minVersion}` out of `null` throws, while
        // isDependencyMinVersionRule(null) correctly returns false first.
        id: 'policy-broken',
        userId: 'user-1',
        name: 'Broken Policy',
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        severity: Severity.HIGH,
        rule: null,
        enabled: true,
        createdAt: new Date(),
      },
      makePolicy({
        id: 'policy-valid',
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'postcss', installedVersion: '1.0.0', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');

    let violations: Awaited<ReturnType<typeof evaluatePolicies>> = [];
    await expect(
      (async () => {
        violations = await evaluatePolicies('user-1', 'scan-1');
      })(),
    ).resolves.not.toThrow();

    expect(violations).toHaveLength(1);
    expect(violations[0].policyId).toBe('policy-valid');
    expect(violations[0].affectedPackages[0]).toContain('postcss@1.0.0');
  });

  it('DEPENDENCY_MIN_VERSION — warns visibly when unparseable installs are skipped, even without a violation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'leftpad', minVersion: '1.0.0' },
      }),
    ]);
    mockScanFindFirst.mockResolvedValue(
      makeScan({
        dependencies: [
          { id: 'd1', name: 'leftpad', installedVersion: 'workspace:*', ageInDays: null },
        ],
      }),
    );

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    const violations = await evaluatePolicies('user-1', 'scan-1');

    expect(violations).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('leftpad');
    warnSpy.mockRestore();
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

describe('evaluatePolicies(): untracked/archived repo scoping', () => {
  it('scopes the scan lookup by { id, repo: { userId, tracked: true } }: exact where clause', async () => {
    mockPolicyFindMany.mockResolvedValue([]);
    mockScanFindFirst.mockResolvedValue(makeScan());

    const { evaluatePolicies } = await import('@/lib/policy/engine');
    await evaluatePolicies('user-1', 'scan-1');

    expect(mockScanFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'scan-1',
        repo: { userId: 'user-1', tracked: true },
      },
      include: {
        licenses: true,
        advisories: true,
        dependencies: true,
      },
    });
  });

  it('a stale scanId on a now-untracked (e.g. archived) repo is treated as not found, so no violation is reported', async () => {
    mockPolicyFindMany.mockResolvedValue([
      makePolicy({
        type: PolicyType.DEPENDENCY_MIN_VERSION,
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    ]);
    // Simulates Prisma's `repo: { userId, tracked: true }` filtering the row
    // away once the repo has been untracked (e.g. archived on GitHub).
    mockScanFindFirst.mockResolvedValue(null);

    const { evaluatePolicies } = await import('@/lib/policy/engine');

    await expect(evaluatePolicies('user-1', 'scan-1')).rejects.toThrow(
      'Scan scan-1 not found or not owned by user user-1',
    );
  });
});

describe('validateDependencyMinVersionRule()', () => {
  it('normalizes a padded package name so it can never desync from the evaluator\'s exact-match lookup', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    const result = validateDependencyMinVersionRule({ package: ' postcss\n', minVersion: '8.5.18' });

    expect(result.error).toBeUndefined();
    expect(result.rule).toEqual({ package: 'postcss', minVersion: '8.5.18' });
  });

  it('rejects a non-object rule', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    expect(validateDependencyMinVersionRule(null).error).toBe('rule must be an object');
    expect(validateDependencyMinVersionRule('not-an-object').error).toBe('rule must be an object');
    expect(validateDependencyMinVersionRule(['x']).error).toBe('rule must be an object');
  });

  it('rejects a missing or empty package', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    expect(validateDependencyMinVersionRule({ minVersion: '8.5.18' }).error).toBe('package is required');
    expect(validateDependencyMinVersionRule({ package: '   ', minVersion: '8.5.18' }).error).toBe('package is required');
  });

  it('rejects a non-semver minVersion', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    expect(validateDependencyMinVersionRule({ package: 'postcss', minVersion: '8.5' }).error)
      .toBe('minVersion must be a valid semver version');
  });

  // R3 (fix round 3): `trim()` removes ASCII/Unicode whitespace (including
  // NBSP and the ideographic space) but not zero-width characters, so a
  // package name carrying one previously sailed through untouched, was
  // stored as-is, and never matched the evaluator's exact
  // `d.name === targetPackage` lookup against a real (zero-width-free)
  // installed name — a policy that reports clean forever, the same failure
  // mode trimming itself exists to prevent.
  it('rejects a package name containing a zero-width character', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    expect(validateDependencyMinVersionRule({ package: 'postcss\u200B', minVersion: '8.5.18' }).error)
      .toBe('package must not contain invisible characters');
  });

  // npm package names are always lowercase; a mixed-case name also passes
  // every other check here but never matches a real installed dependency
  // name — again the same "reports clean forever" failure mode.
  it('rejects a package name that is not lowercase npm grammar', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    expect(validateDependencyMinVersionRule({ package: 'PostCSS', minVersion: '8.5.18' }).error)
      .toBe('package must be a valid npm package name');
  });

  // Verifies the npm-name regex itself against real package name shapes
  // (dotted, underscored, hyphenated, scoped, and a hyphenated scope with a
  // hyphenated name) rather than trusting it unexercised.
  it('accepts real npm package name shapes: dotted, underscored, hyphenated, and scoped', async () => {
    const { validateDependencyMinVersionRule } = await import('@/lib/policy/engine');

    const shapes = [
      'lodash.merge',
      'left_pad',
      'is-number',
      '@babel/core',
      '@size-limit/preset-app',
    ];

    for (const pkg of shapes) {
      const result = validateDependencyMinVersionRule({ package: pkg, minVersion: '8.5.18' });
      expect(result.error).toBeUndefined();
      expect(result.rule).toEqual({ package: pkg, minVersion: '8.5.18' });
    }
  });
});
