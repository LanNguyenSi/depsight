// Route-level tests for GET, PUT, DELETE /api/policies/[id].
// Uses resolveRequestUser() (session or dsat_ bearer token) and the policy
// service boundary.
//
// resolveRequestUser() itself (session vs. Bearer dsat_ token, revocation)
// is unit-tested in tests/unit/auth-api.test.ts; most tests below mock it
// directly rather than re-proving its internal branches. The two
// "(real auth-api composition)" tests near the bottom of this file are the
// exception: they leave @/lib/auth-api unmocked to prove the route actually
// wires a Bearer dsat_ token through to a 200 and a revoked token to 401.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { resolveRequestUserMock, getPolicyByIdMock, updatePolicyMock, deletePolicyMock } = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  getPolicyByIdMock: vi.fn(),
  updatePolicyMock: vi.fn(),
  deletePolicyMock: vi.fn(),
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
  getPolicyById: getPolicyByIdMock,
  updatePolicy: updatePolicyMock,
  deletePolicy: deletePolicyMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, PUT, DELETE } from '@/app/api/policies/[id]/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeGetRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/policies/${id}`, { method: 'GET' });
}

function makePutRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/policies/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/policies/${id}`, { method: 'DELETE' });
}

const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok', scope: 'WRITE' as const };
const readOnlyUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok', scope: 'READ' as const };

// ---------------------------------------------------------------------------
// Tests — GET /api/policies/[id]
// ---------------------------------------------------------------------------
describe('GET /api/policies/[id]', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    getPolicyByIdMock.mockReset();
    updatePolicyMock.mockReset();
    deletePolicyMock.mockReset();
  });

  it('(1) returns 401 when there is neither a session nor a token', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 404 when getPolicyById returns null', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest('pol-missing'), makeParams('pol-missing'));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-1', 'pol-missing');
  });

  it('(3) returns 200 with policy when found', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    const policy = {
      id: 'pol-1',
      name: 'Block GPL',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      enabled: true,
    };
    getPolicyByIdMock.mockResolvedValue(policy);

    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(200);
    const body = await res.json() as { policy: object };
    expect(body.policy).toMatchObject({ id: 'pol-1', name: 'Block GPL' });
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-1', 'pol-1');
  });

  it('(3b) returns 200 for a READ-scoped token (read is allowed on both scopes)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1', name: 'Block GPL', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true,
    });

    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests — PUT /api/policies/[id]
// ---------------------------------------------------------------------------
describe('PUT /api/policies/[id]', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    getPolicyByIdMock.mockReset();
    updatePolicyMock.mockReset();
    deletePolicyMock.mockReset();
  });

  it('(4) returns 401 when there is neither a session nor a token', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await PUT(makePutRequest('pol-1', { name: 'Updated' }), makeParams('pol-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(4b) returns 403 when the token has READ scope only (no write access)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);

    const res = await PUT(makePutRequest('pol-1', { name: 'Updated' }), makeParams('pol-1'));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('This token does not have write access');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(5) returns 400 when type is an invalid enum value', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', { type: 'INVALID_TYPE' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid type');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(6) returns 400 when severity is an invalid enum value', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', { severity: 'EXTREME' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid severity');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(7) returns 400 when rule is a string (not a plain object)', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', { rule: 'not-an-object' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(7b) returns 400 when rule is null', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', { rule: null }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(7c) returns 400 when rule is an array', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', { rule: ['item'] }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(8) returns 404 when updatePolicy returns null (ownership mismatch)', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    updatePolicyMock.mockResolvedValue(null);

    const res = await PUT(
      makePutRequest('pol-other', { name: 'Updated' }),
      makeParams('pol-other'),
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
  });

  it('(9) returns 200 with updated policy on success', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    const updated = {
      id: 'pol-1',
      name: 'Updated Name',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      enabled: true,
    };
    updatePolicyMock.mockResolvedValue(updated);

    const res = await PUT(
      makePutRequest('pol-1', { name: 'Updated Name' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { policy: object };
    expect(body.policy).toMatchObject({ id: 'pol-1', name: 'Updated Name' });
    expect(updatePolicyMock).toHaveBeenCalledWith(
      'user-1',
      'pol-1',
      expect.objectContaining({ name: 'Updated Name' }),
    );
  });

  it('(10) accepts all valid PolicyType values without 400', async () => {
    const validTypes = ['LICENSE_DENY', 'LICENSE_ALLOW_ONLY', 'CVE_MIN_SEVERITY', 'DEPENDENCY_MAX_AGE', 'DEPENDENCY_MIN_VERSION'];
    for (const type of validTypes) {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      updatePolicyMock.mockResolvedValue({ id: 'pol-1', name: 'P', type, severity: 'HIGH', enabled: true });

      // DEPENDENCY_MIN_VERSION requires a compatible rule (see the (9x)/(door)
      // tests below): sending `type` alone for it is door (b) and is no
      // longer accepted, so this type is exercised with a rule attached.
      const body = type === 'DEPENDENCY_MIN_VERSION'
        ? { type, rule: { package: 'postcss', minVersion: '8.5.18' } }
        : { type };

      const res = await PUT(
        makePutRequest('pol-1', body),
        makeParams('pol-1'),
      );
      expect(res.status).toBe(200);
    }
  });

  // ---------------------------------------------------------------------------
  // (9x) DEPENDENCY_MIN_VERSION rule validation on PUT
  // ---------------------------------------------------------------------------
  it('(9a) returns 400 when DEPENDENCY_MIN_VERSION minVersion is not valid semver', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', {
        type: 'DEPENDENCY_MIN_VERSION',
        rule: { package: 'postcss', minVersion: '8.5' },
      }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('minVersion must be a valid semver version');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(9c) returns 400 when DEPENDENCY_MIN_VERSION package is missing', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', {
        type: 'DEPENDENCY_MIN_VERSION',
        rule: { minVersion: '8.5.18' },
      }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package is required');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(9d) returns 400 when DEPENDENCY_MIN_VERSION package is an empty string', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);

    const res = await PUT(
      makePutRequest('pol-1', {
        type: 'DEPENDENCY_MIN_VERSION',
        rule: { package: '  ', minVersion: '8.5.18' },
      }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package is required');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(9b) returns 200 when DEPENDENCY_MIN_VERSION rule is valid alongside the type', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    updatePolicyMock.mockResolvedValue({
      id: 'pol-1', name: 'P', type: 'DEPENDENCY_MIN_VERSION', severity: 'HIGH', enabled: true,
    });

    const res = await PUT(
      makePutRequest('pol-1', {
        type: 'DEPENDENCY_MIN_VERSION',
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(200);
    expect(updatePolicyMock).toHaveBeenCalledWith(
      'user-1',
      'pol-1',
      expect.objectContaining({
        type: 'DEPENDENCY_MIN_VERSION',
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Two doors into an unvalidated DEPENDENCY_MIN_VERSION rule when `type` and
  // `rule` are updated independently rather than together.
  // ---------------------------------------------------------------------------
  it('(10a) door (a): validates a rule-only update against the stored type', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Floor postcss',
      type: 'DEPENDENCY_MIN_VERSION',
      severity: 'HIGH',
      rule: { package: 'postcss', minVersion: '8.5.18' },
      enabled: true,
    });

    const res = await PUT(
      makePutRequest('pol-1', { rule: { package: 'postcss', minVersion: '8.5' } }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('minVersion must be a valid semver version');
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-1', 'pol-1');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(10b) door (b): validates the stored rule when only `type` flips to DEPENDENCY_MIN_VERSION', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Block GPL',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      rule: { deniedLicenses: ['GPL-3.0'] },
      enabled: true,
    });

    const res = await PUT(
      makePutRequest('pol-1', { type: 'DEPENDENCY_MIN_VERSION' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('package is required');
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-1', 'pol-1');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(10c) door (b) with a stored rule that is not even an object still returns 400, not a throw', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Legacy Policy',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      rule: null,
      enabled: true,
    });

    const res = await PUT(
      makePutRequest('pol-1', { type: 'DEPENDENCY_MIN_VERSION' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('rule must be an object');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  it('(10d) door (a)/(b) fetch returns 404 when the policy does not belong to the user', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue(null);

    const res = await PUT(
      makePutRequest('pol-missing', { type: 'DEPENDENCY_MIN_VERSION' }),
      makeParams('pol-missing'),
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // R1/R2 (fix round 3): every write path for this policy type must persist
  // the *validated* rule, not whatever the request (or the previously
  // stored row) happened to carry. Door (b) in particular used to be a
  // silent no-op here: `updateData.rule` stayed `undefined` on that path, so
  // updatePolicy() never got the normalized rule and a padded/unnormalized
  // stored rule survived a type flip untouched.
  // ---------------------------------------------------------------------------
  it('(10e) door (a): persists the normalized (trimmed) package name from a rule-only update', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Floor postcss',
      type: 'DEPENDENCY_MIN_VERSION',
      severity: 'HIGH',
      rule: { package: 'postcss', minVersion: '8.5.0' },
      enabled: true,
    });
    updatePolicyMock.mockResolvedValue({
      id: 'pol-1', name: 'Floor postcss', type: 'DEPENDENCY_MIN_VERSION', severity: 'HIGH', enabled: true,
    });

    const res = await PUT(
      makePutRequest('pol-1', { rule: { package: '  postcss  ', minVersion: '8.5.18' } }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(200);
    expect(updatePolicyMock).toHaveBeenCalledWith(
      'user-1',
      'pol-1',
      expect.objectContaining({ rule: { package: 'postcss', minVersion: '8.5.18' } }),
    );
  });

  it('(10f) door (b): persists the normalized (trimmed) stored rule when only `type` flips to DEPENDENCY_MIN_VERSION', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Floor postcss (mislabeled)',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      // A DEPENDENCY_MIN_VERSION-shaped rule left over on a policy of a
      // different type, carrying a padded package name that was never
      // trimmed because it was never validated as a DMV rule before now.
      rule: { package: '  postcss  ', minVersion: '8.5.18' },
      enabled: true,
    });
    updatePolicyMock.mockResolvedValue({
      id: 'pol-1', name: 'Floor postcss (mislabeled)', type: 'DEPENDENCY_MIN_VERSION', severity: 'HIGH', enabled: true,
    });

    const res = await PUT(
      makePutRequest('pol-1', { type: 'DEPENDENCY_MIN_VERSION' }),
      makeParams('pol-1'),
    );

    expect(res.status).toBe(200);
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-1', 'pol-1');
    expect(updatePolicyMock).toHaveBeenCalledWith(
      'user-1',
      'pol-1',
      expect.objectContaining({
        type: 'DEPENDENCY_MIN_VERSION',
        rule: { package: 'postcss', minVersion: '8.5.18' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/policies/[id]
// ---------------------------------------------------------------------------
describe('DELETE /api/policies/[id]', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    getPolicyByIdMock.mockReset();
    updatePolicyMock.mockReset();
    deletePolicyMock.mockReset();
  });

  it('(11) returns 401 when there is neither a session nor a token', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await DELETE(makeDeleteRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(11b) returns 403 when the token has READ scope only (no write access)', async () => {
    resolveRequestUserMock.mockResolvedValue(readOnlyUser);

    const res = await DELETE(makeDeleteRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('This token does not have write access');
    expect(deletePolicyMock).not.toHaveBeenCalled();
  });

  it('(12) returns 404 when deletePolicy returns false (policy not found)', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    deletePolicyMock.mockResolvedValue(false);

    const res = await DELETE(makeDeleteRequest('pol-missing'), makeParams('pol-missing'));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    expect(deletePolicyMock).toHaveBeenCalledWith('user-1', 'pol-missing');
  });

  it('(13) returns 200 with success:true when policy is deleted', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    deletePolicyMock.mockResolvedValue(true);

    const res = await DELETE(makeDeleteRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(deletePolicyMock).toHaveBeenCalledWith('user-1', 'pol-1');
  });
});

// ---------------------------------------------------------------------------
// Tests — real auth-api composition (no @/lib/auth-api mock)
// ---------------------------------------------------------------------------
// The tests above mock @/lib/auth-api directly, so they never actually
// exercise a Bearer dsat_ token through the real resolveRequestUser(). These
// two tests unmock it and stub its own dependencies (@/lib/auth, next/headers,
// @/lib/prisma) instead, following the pattern in tests/unit/auth-api.test.ts.
// That proves the route is really wired to the token path end to end, not
// just to a mock that returns a user object. This block relies on vitest's
// per-file isolation to keep its unmocked @/lib/auth-api from leaking into
// other test files; it would need its own cleanup if isolation were ever
// turned off.
describe('GET /api/policies/[id] (real auth-api composition)', () => {
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
      getPolicyById: getPolicyByIdMock,
      updatePolicy: updatePolicyMock,
      deletePolicy: deletePolicyMock,
    }));

    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUniqueMock.mockReset();
    apiTokenUpdateMock.mockReset();
    apiTokenUpdateMock.mockResolvedValue({});
    getPolicyByIdMock.mockReset();
    updatePolicyMock.mockReset();
    deletePolicyMock.mockReset();
  });

  it('(14) returns 200 for a valid READ-scoped dsat_ token with no session', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_live_token' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-live',
      revokedAt: null,
      scope: 'READ',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Block GPL',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      enabled: true,
    });

    const { GET } = await import('@/app/api/policies/[id]/route');
    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(200);
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-9', 'pol-1');
  });

  it('(15) returns 401 for a revoked dsat_ token with no session', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_revoked' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-revoked',
      revokedAt: new Date('2026-01-01T00:00:00Z'),
      scope: 'WRITE',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });

    const { GET } = await import('@/app/api/policies/[id]/route');
    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(401);
    expect(getPolicyByIdMock).not.toHaveBeenCalled();
  });

  it('(16) PUT returns 403 for a valid but READ-scoped dsat_ token with no session (end-to-end through the real resolveRequestUser)', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_readonly' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-readonly',
      revokedAt: null,
      scope: 'READ',
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });

    const { PUT } = await import('@/app/api/policies/[id]/route');
    const res = await PUT(makePutRequest('pol-1', { name: 'Updated' }), makeParams('pol-1'));

    expect(res.status).toBe(403);
    expect(updatePolicyMock).not.toHaveBeenCalled();
  });
});
