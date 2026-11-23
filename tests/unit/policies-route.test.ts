// Route-level tests for GET /api/policies and POST /api/policies.
// Uses resolveRequestUser() (session or dsat_ bearer token). listPolicies and
// createPolicy are mocked at the service boundary. PolicyType and Severity
// enums are real @prisma/client values.
//
// resolveRequestUser() itself (session vs. Bearer dsat_ token, revocation)
// is unit-tested in tests/unit/auth-api.test.ts; most tests below mock it
// directly rather than re-proving its internal branches. The
// "(real auth-api composition)" tests near the bottom of this file are the
// exception: they leave @/lib/auth-api unmocked to prove the route actually
// wires a Bearer dsat_ token through to a 200/201 and a revoked token to 401.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { resolveRequestUserMock, listPoliciesMock, createPolicyMock, countPoliciesMock } = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  listPoliciesMock: vi.fn(),
  createPolicyMock: vi.fn(),
  countPoliciesMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// hasWriteScope is the real implementation here (not itself under test in
// this file, see auth-api.test.ts), pulled in via vi.importActual so a
// regression in the actual predicate is caught by these route tests too,
// not just by a hand-copied stand-in that could silently drift from it.
vi.mock('@/lib/auth-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-api')>('@/lib/auth-api');
  return {
    resolveRequestUser: resolveRequestUserMock,
    hasWriteScope: actual.hasWriteScope,
  };
});
// Stubs so the real @/lib/auth-api module (loaded above via importActual,
// purely to get its real hasWriteScope) can load without crashing: its own
// top-level imports (./auth -> next-auth, next/headers, ./prisma) would
// otherwise execute for real during that import. hasWriteScope itself is a
// pure function on user.scope and never touches any of these, so the stub
// values are never exercised; the "(real auth-api composition)" block below
// overrides these same specifiers with its own vi.doMock for its own tests.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { apiToken: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock('@/lib/policy/service', () => ({
  listPolicies: listPoliciesMock,
  createPolicy: createPolicyMock,
  countPolicies: countPoliciesMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/policies/route';
import { NextRequest } from 'next/server';
import { DEFAULT_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';
import {
  policyCreateRateLimiter,
  POLICY_CREATE_LIMIT_PER_HOUR,
  MAX_POLICIES_PER_USER,
} from '@/lib/rate-limit';
import { MAX_RULE_ARRAY_ENTRIES, MAX_RULE_ARRAY_ENTRY_LENGTH } from '@/lib/policy/engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/policies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validPolicyBody() {
  return {
    name: 'Block GPL',
    type: 'LICENSE_DENY',
    severity: 'HIGH',
    rule: { deniedLicenses: ['GPL-3.0'] },
  };
}

const VALID_RULES: Record<string, Record<string, unknown>> = {
  LICENSE_DENY: { deniedLicenses: ['GPL-3.0'] },
  LICENSE_ALLOW_ONLY: { allowedLicenses: ['MIT'] },
  CVE_MIN_SEVERITY: { minSeverity: 'HIGH' },
  DEPENDENCY_MAX_AGE: { maxAgeDays: 365 },
  DEPENDENCY_MIN_VERSION: { package: 'postcss', minVersion: '8.5.18' },
};

const MALFORMED_RULES: Array<[string, Record<string, unknown>]> = [
  ['LICENSE_DENY', { deniedLicenses: 'GPL-3.0' }],
  ['LICENSE_DENY', { licenses: ['GPL-3.0'] }],
  ['LICENSE_ALLOW_ONLY', { allowedLicenses: [1, 2] }],
  ['LICENSE_ALLOW_ONLY', {}],
  ['CVE_MIN_SEVERITY', { minSeverity: 'critical' }],
  ['CVE_MIN_SEVERITY', { minSeverity: 3 }],
  ['DEPENDENCY_MAX_AGE', { maxAgeDays: '365' }],
  ['DEPENDENCY_MAX_AGE', { maxAge: 365 }],
  ['DEPENDENCY_MIN_VERSION', { package: 'postcss', minVersion: '8.5' }],
];

const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok', scope: 'WRITE' as const };
const readOnlyUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok', scope: 'READ' as const };

// ---------------------------------------------------------------------------
// Tests — GET /api/policies
// ---------------------------------------------------------------------------
describe('GET /api/policies', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    listPoliciesMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset().mockResolvedValue(0);
    policyCreateRateLimiter.reset();
  });

  it('(1) returns 401 when there is neither a session nor a token', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 200 with policies list and calls listPolicies with userId (session)', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    listPoliciesMock.mockResolvedValue([
      { id: 'pol-1', name: 'Block GPL', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { policies: object[] };
    expect(body.policies).toHaveLength(1);
    expect(listPoliciesMock).toHaveBeenCalledWith('user-1');
  });

  it('(2b) returns 200 for a READ-scoped token (read is allowed on both scopes)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);
    listPoliciesMock.mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(listPoliciesMock).toHaveBeenCalledWith('user-1');
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/policies
// ---------------------------------------------------------------------------
describe('POST /api/policies', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    listPoliciesMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset().mockResolvedValue(0);
    policyCreateRateLimiter.reset();
  });

  it('(3) returns 401 when there is neither a session nor a token', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(3b) returns 403 when the token has READ scope only (no write access)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('This token does not have write access');
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('(4) returns 400 when name is missing', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const withoutName = { ...validPolicyBody() };
    delete (withoutName as Record<string, unknown>).name;
    const res = await POST(makePostRequest(withoutName));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('name is required');
  });

  it('(4) returns 400 when name is empty string', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), name: '' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('name is required');
  });

  it('(5) returns 400 when type is an invalid enum value', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), type: 'INVALID_TYPE' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid type');
  });

  it('(6) returns 400 when severity is an invalid enum value', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), severity: 'SUPER_CRITICAL' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid severity');
  });

  it('(7) returns 400 when rule is not an object (is a string)', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), rule: 'not-an-object' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
  });

  it('(7) returns 400 when rule is an array (not a plain object)', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), rule: ['item'] }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
  });

  it('(7) returns 400 when rule is null', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), rule: null }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
  });

  it('(8) returns 201 with policy on valid inputs, calls createPolicy with userId', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    const createdPolicy = { id: 'pol-new', name: 'Block GPL', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true };
    createPolicyMock.mockResolvedValue(createdPolicy);

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(201);
    const body = await res.json() as { policy: object };
    expect(body.policy).toMatchObject({ id: 'pol-new', name: 'Block GPL' });

    expect(createPolicyMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        name: 'Block GPL',
        type: 'LICENSE_DENY',
        severity: 'HIGH',
        rule: { deniedLicenses: ['GPL-3.0'] },
        enabled: true,
      }),
    );
  });

  it('(8) accepts all valid PolicyType values', async () => {
    const validTypes = ['LICENSE_DENY', 'LICENSE_ALLOW_ONLY', 'CVE_MIN_SEVERITY', 'DEPENDENCY_MAX_AGE', 'DEPENDENCY_MIN_VERSION'];
    for (const type of validTypes) {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      createPolicyMock.mockResolvedValue({ id: 'pol-x', name: 'P', type, severity: 'HIGH', enabled: true });

      // Every type is shape-validated by validatePolicyRule, so each type
      // is created with its own fitting VALID_RULES fixture.
      const rule = VALID_RULES[type];

      const res = await POST(makePostRequest({ ...validPolicyBody(), type, rule }));
      expect(res.status).toBe(201);
    }
  });

  it.each(MALFORMED_RULES)('(8m) returns 400 for a malformed %s rule %j and does not persist', async (type, rule) => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({ ...validPolicyBody(), type, rule }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (9x) DEPENDENCY_MIN_VERSION rule validation
  // ---------------------------------------------------------------------------
  it('(9a) returns 400 when DEPENDENCY_MIN_VERSION minVersion is not valid semver', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { package: 'postcss', minVersion: '8.5' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('minVersion must be a valid semver version');
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('(9b) returns 201 when DEPENDENCY_MIN_VERSION minVersion is valid semver', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    createPolicyMock.mockResolvedValue({
      id: 'pol-new', name: 'Floor postcss', type: 'DEPENDENCY_MIN_VERSION', severity: 'HIGH', enabled: true,
    });

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { package: 'postcss', minVersion: '8.5.18' },
    }));

    expect(res.status).toBe(201);
    expect(createPolicyMock).toHaveBeenCalled();
  });

  it('(9c) returns 400 when DEPENDENCY_MIN_VERSION package is missing', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { minVersion: '8.5.18' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package is required');
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('(9d) returns 400 when DEPENDENCY_MIN_VERSION package is an empty string', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { package: '  ', minVersion: '8.5.18' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package is required');
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  // R2/R3 (fix round 3): the route must persist validateDependencyMinVersionRule's
  // *normalized* return value, not the raw request body's rule — proving the
  // POST write path actually reads `ruleToPersist` (the validated result)
  // rather than the untouched `rule` variable. See the sibling test in
  // tests/unit/policies-id-route.test.ts for the PUT write paths.
  it('(9e) persists the normalized (trimmed) package name from a DEPENDENCY_MIN_VERSION rule', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    createPolicyMock.mockResolvedValue({
      id: 'pol-new', name: 'Floor postcss', type: 'DEPENDENCY_MIN_VERSION', severity: 'HIGH', enabled: true,
    });

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { package: '  postcss  ', minVersion: '8.5.18' },
    }));

    expect(res.status).toBe(201);
    expect(createPolicyMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ rule: { package: 'postcss', minVersion: '8.5.18' } }),
    );
  });

  // ---------------------------------------------------------------------------
  // (10x) DEPENDENCY_MIN_VERSION package-name normalization/rejection
  // ---------------------------------------------------------------------------
  it('(10x-a) returns 400 when package contains a zero-width character', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { package: 'postcss\u200B', minVersion: '8.5.18' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package must not contain invisible characters');
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('(10x-b) returns 400 when package is not lowercase npm grammar', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await POST(makePostRequest({
      ...validPolicyBody(),
      type: 'DEPENDENCY_MIN_VERSION',
      rule: { package: 'PostCSS', minVersion: '8.5.18' },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package must be a valid npm package name');
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('(8) accepts all valid Severity values', async () => {
    const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
    for (const severity of validSeverities) {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      createPolicyMock.mockResolvedValue({ id: 'pol-x', name: 'P', type: 'LICENSE_DENY', severity, enabled: true });

      const res = await POST(makePostRequest({ ...validPolicyBody(), severity }));
      expect(res.status).toBe(201);
    }
  });

  it('(8) defaults enabled to true when not provided', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    createPolicyMock.mockResolvedValue({ id: 'pol-x', name: 'Block GPL', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true });

    const bodyWithoutEnabled = validPolicyBody();
    const res = await POST(makePostRequest(bodyWithoutEnabled));
    expect(res.status).toBe(201);

    expect(createPolicyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — real auth-api composition (no @/lib/auth-api mock)
// ---------------------------------------------------------------------------
// The tests above mock @/lib/auth-api directly, so they never actually
// exercise a Bearer dsat_ token through the real resolveRequestUser(). These
// tests unmock it and stub its own dependencies (@/lib/auth, next/headers,
// @/lib/prisma) instead, following the pattern in tests/unit/auth-api.test.ts.
// That proves the route is really wired to the token path end to end, not
// just to a mock that returns a user object. This block relies on vitest's
// per-file isolation to keep its unmocked @/lib/auth-api from leaking into
// other test files; it would need its own cleanup if isolation were ever
// turned off.
describe('GET/POST /api/policies (real auth-api composition)', () => {
  const authMock = vi.fn();
  const headersMock = vi.fn();
  const apiTokenFindUniqueMock = vi.fn();
  const apiTokenUpdateMock = vi.fn().mockResolvedValue({});

  function buildHeaders(map: Record<string, string>) {
    return {
      get: (k: string) => map[k.toLowerCase()] ?? null,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/auth-api');
    vi.doMock('@/lib/auth', () => ({ auth: authMock }));
    vi.doMock('next/headers', () => ({ headers: headersMock }));
    vi.doMock('@/lib/prisma', () => ({
      prisma: {
        apiToken: {
          findUnique: apiTokenFindUniqueMock,
          update: apiTokenUpdateMock,
        },
      },
    }));
    vi.doMock('@/lib/policy/service', () => ({
      listPolicies: listPoliciesMock,
      createPolicy: createPolicyMock,
      countPolicies: countPoliciesMock,
    }));

    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUniqueMock.mockReset();
    apiTokenUpdateMock.mockReset();
    apiTokenUpdateMock.mockResolvedValue({});
    listPoliciesMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset().mockResolvedValue(0);
    policyCreateRateLimiter.reset();
  });

  it('(2c) returns 200 for a valid READ-scoped dsat_ token with no session', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_live_token' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-live',
      revokedAt: null,
      scope: 'READ',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });
    listPoliciesMock.mockResolvedValue([]);

    const { GET } = await import('@/app/api/policies/route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(listPoliciesMock).toHaveBeenCalledWith('user-9');
  });

  it('(2d) returns 401 for a revoked dsat_ token with no session', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_revoked' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-revoked',
      revokedAt: new Date('2026-01-01T00:00:00Z'),
      scope: 'WRITE',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });

    const { GET } = await import('@/app/api/policies/route');
    const res = await GET();

    expect(res.status).toBe(401);
    expect(listPoliciesMock).not.toHaveBeenCalled();
  });

  it('(2e) POST returns 201 for a valid WRITE-scoped dsat_ token with no session, and creates the policy for the token owner', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_live_token' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-live',
      revokedAt: null,
      scope: 'WRITE',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });
    createPolicyMock.mockResolvedValue({ id: 'pol-new', name: 'Block GPL', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true });

    const { POST } = await import('@/app/api/policies/route');
    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(201);
    expect(createPolicyMock).toHaveBeenCalledWith('user-9', expect.anything());
  });

  it('(2f) POST returns 403 for a valid but READ-scoped dsat_ token with no session (end-to-end through the real resolveRequestUser)', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_readonly' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-readonly',
      revokedAt: null,
      scope: 'READ',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });

    const { POST } = await import('@/app/api/policies/route');
    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(403);
    expect(createPolicyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/policies: request body cap', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset().mockResolvedValue(0);
    policyCreateRateLimiter.reset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('answers 413 for a body over the cap and creates nothing', async () => {
    const res = await POST(makePostRequest({ name: 'x'.repeat(DEFAULT_JSON_BODY_BYTES), type: 'LICENSE' }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(createPolicyMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/policies: per-user rate limit
// ---------------------------------------------------------------------------
describe('POST /api/policies: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    policyCreateRateLimiter.reset();
    resolveRequestUserMock.mockReset();
    listPoliciesMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset().mockResolvedValue(0);
    createPolicyMock.mockResolvedValue({ id: 'pol-new' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('budgets 60 creates per user and hour', () => {
    expect(POLICY_CREATE_LIMIT_PER_HOUR).toBe(60);
  });

  it('answers 429 with Retry-After on the (limit+1)th call and creates nothing', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(201);
    }
    expect(createPolicyMock).toHaveBeenCalledTimes(POLICY_CREATE_LIMIT_PER_HOUR);

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(createPolicyMock).toHaveBeenCalledTimes(POLICY_CREATE_LIMIT_PER_HOUR);
  });

  it('does not count 401 or 403 rejections', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(401);
    }
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);
    for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(403);
    }

    resolveRequestUserMock.mockResolvedValue(mockUser);
    for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(201);
    }
    expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(429);
  });

  it('limits per user: a different caller keeps a full budget', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(201);
    }
    expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(429);

    resolveRequestUserMock.mockResolvedValue({ ...mockUser, id: 'someone-else' });
    expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(201);
  });

  it('runs the limiter before validation and the count: an over-budget invalid body answers 429 with no count and no create', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(201);
    }
    countPoliciesMock.mockClear();
    createPolicyMock.mockClear();

    // A rule that would fail validation (a non-object rule) if the limiter ran
    // after validation; the limiter is first, so this is 429, not 400.
    const res = await POST(makePostRequest({ ...validPolicyBody(), rule: 'not-an-object' }));

    expect(res.status).toBe(429);
    expect(countPoliciesMock).not.toHaveBeenCalled();
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  // Raw bodies the body reader or the first validation would reject: once the
  // budget is spent the limiter must answer first, so these are 429.
  describe('limiter runs before the body is read', () => {
    const rawRequest = (body: string): NextRequest =>
      new NextRequest('http://localhost/api/policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    async function spendBudget(): Promise<void> {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      for (let i = 0; i < POLICY_CREATE_LIMIT_PER_HOUR; i++) {
        expect((await POST(makePostRequest(validPolicyBody()))).status).toBe(201);
      }
      countPoliciesMock.mockClear();
      createPolicyMock.mockClear();
    }

    it('answers 429, not a parse error, for malformed JSON once the budget is spent', async () => {
      await spendBudget();

      const res = await POST(rawRequest('{not json'));

      expect(res.status).toBe(429);
      expect(countPoliciesMock).not.toHaveBeenCalled();
      expect(createPolicyMock).not.toHaveBeenCalled();
    });

    it('answers 429, not 413, for a body over the read cap once the budget is spent', async () => {
      await spendBudget();

      const res = await POST(rawRequest(JSON.stringify({ pad: 'x'.repeat(DEFAULT_JSON_BODY_BYTES) })));

      expect(res.status).toBe(429);
      expect(countPoliciesMock).not.toHaveBeenCalled();
      expect(createPolicyMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/policies: per-user count cap
// ---------------------------------------------------------------------------
describe('POST /api/policies: per-user count cap', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset();
    policyCreateRateLimiter.reset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
    createPolicyMock.mockResolvedValue({ id: 'pol-new' });
  });

  it('answers 409 with a message naming the cap at the cap and creates nothing', async () => {
    countPoliciesMock.mockResolvedValue(MAX_POLICIES_PER_USER);

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(`A user can have at most ${MAX_POLICIES_PER_USER} policies`);
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('creates successfully one below the cap', async () => {
    countPoliciesMock.mockResolvedValue(MAX_POLICIES_PER_USER - 1);

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(201);
    expect(createPolicyMock).toHaveBeenCalledTimes(1);
  });

  it('counts only the caller rows', async () => {
    countPoliciesMock.mockResolvedValue(0);
    await POST(makePostRequest(validPolicyBody()));
    expect(countPoliciesMock).toHaveBeenCalledWith('user-1');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/policies: bounded rule arrays
// ---------------------------------------------------------------------------
describe('POST /api/policies: bounded rule arrays', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    createPolicyMock.mockReset();
    countPoliciesMock.mockReset().mockResolvedValue(0);
    policyCreateRateLimiter.reset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
    createPolicyMock.mockResolvedValue({ id: 'pol-new' });
  });

  it('rejects deniedLicenses over the entry bound, naming the bound', async () => {
    const res = await POST(
      makePostRequest({
        name: 'Big GPL list',
        type: 'LICENSE_DENY',
        severity: 'HIGH',
        rule: { deniedLicenses: Array.from({ length: MAX_RULE_ARRAY_ENTRIES + 1 }, (_, i) => `GPL-${i}`) },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(`rule.deniedLicenses must contain at most ${MAX_RULE_ARRAY_ENTRIES} entries`);
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('rejects a deniedLicenses entry over the length bound, naming the bound', async () => {
    const res = await POST(
      makePostRequest({
        name: 'Long license',
        type: 'LICENSE_DENY',
        severity: 'HIGH',
        rule: { deniedLicenses: ['x'.repeat(MAX_RULE_ARRAY_ENTRY_LENGTH + 1)] },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(
      `each entry of rule.deniedLicenses must be at most ${MAX_RULE_ARRAY_ENTRY_LENGTH} characters`,
    );
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('rejects allowedLicenses over the entry bound, naming the field', async () => {
    const res = await POST(
      makePostRequest({
        name: 'Big allow list',
        type: 'LICENSE_ALLOW_ONLY',
        severity: 'HIGH',
        rule: { allowedLicenses: Array.from({ length: MAX_RULE_ARRAY_ENTRIES + 1 }, (_, i) => `MIT-${i}`) },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(`rule.allowedLicenses must contain at most ${MAX_RULE_ARRAY_ENTRIES} entries`);
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it('accepts a rule exactly at both bounds (boundary)', async () => {
    const licenses = Array.from({ length: MAX_RULE_ARRAY_ENTRIES }, (_, i) => `LIC-${i}`);
    licenses[0] = 'x'.repeat(MAX_RULE_ARRAY_ENTRY_LENGTH);

    const res = await POST(
      makePostRequest({
        name: 'Boundary list',
        type: 'LICENSE_DENY',
        severity: 'HIGH',
        rule: { deniedLicenses: licenses },
      }),
    );

    expect(res.status).toBe(201);
    expect(createPolicyMock).toHaveBeenCalledTimes(1);
  });
});
