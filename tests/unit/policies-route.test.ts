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
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { resolveRequestUserMock, listPoliciesMock, createPolicyMock } = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  listPoliciesMock: vi.fn(),
  createPolicyMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
  // Real implementation (not itself under test here — see auth-api.test.ts):
  // scope === 'WRITE' grants write access.
  hasWriteScope: (user: { scope: string }) => user.scope === 'WRITE',
}));
vi.mock('@/lib/policy/service', () => ({
  listPolicies: listPoliciesMock,
  createPolicy: createPolicyMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/policies/route';
import { NextRequest } from 'next/server';

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
    rule: { licenses: ['GPL-3.0'] },
  };
}

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
        rule: { licenses: ['GPL-3.0'] },
        enabled: true,
      }),
    );
  });

  it('(8) accepts all valid PolicyType values', async () => {
    const validTypes = ['LICENSE_DENY', 'LICENSE_ALLOW_ONLY', 'CVE_MIN_SEVERITY', 'DEPENDENCY_MAX_AGE', 'DEPENDENCY_MIN_VERSION'];
    for (const type of validTypes) {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      createPolicyMock.mockResolvedValue({ id: 'pol-x', name: 'P', type, severity: 'HIGH', enabled: true });

      // DEPENDENCY_MIN_VERSION rules are shape-validated (see the (9x) block below),
      // so this generic rule only applies to the other types.
      const rule = type === 'DEPENDENCY_MIN_VERSION'
        ? { package: 'postcss', minVersion: '8.5.18' }
        : validPolicyBody().rule;

      const res = await POST(makePostRequest({ ...validPolicyBody(), type, rule }));
      expect(res.status).toBe(201);
    }
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
    }));

    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUniqueMock.mockReset();
    apiTokenUpdateMock.mockReset();
    apiTokenUpdateMock.mockResolvedValue({});
    listPoliciesMock.mockReset();
    createPolicyMock.mockReset();
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
