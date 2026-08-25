// Route-level tests for GET /api/policies and POST /api/policies.
// Uses resolveRequestUser() (session or dsat_ bearer token). listPolicies and
// createPolicy are mocked at the service boundary. PolicyType and Severity
// enums are real @prisma/client values.
//
// resolveRequestUser() itself (session vs. Bearer dsat_ token, revocation)
// is unit-tested in tests/unit/auth-api.test.ts; most tests below mock it
// directly rather than re-proving its internal branches. The two
// "(real auth-api composition)" tests near the bottom of this file are the
// exception: they leave @/lib/auth-api unmocked to prove the route actually
// wires a Bearer dsat_ token through to a 200/201 and a revoked token to 401.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('@/lib/auth-api', () => ({ resolveRequestUser: resolveRequestUserMock }));
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

const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

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
  });

  it('(3c) forwards the resolved user id to createPolicy', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    createPolicyMock.mockResolvedValue({ id: 'pol-new', name: 'Block GPL', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true });

    const res = await POST(makePostRequest(validPolicyBody()));

    expect(res.status).toBe(201);
    expect(createPolicyMock).toHaveBeenCalledWith('user-1', expect.anything());
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
    const validTypes = ['LICENSE_DENY', 'LICENSE_ALLOW_ONLY', 'CVE_MIN_SEVERITY', 'DEPENDENCY_MAX_AGE'];
    for (const type of validTypes) {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      createPolicyMock.mockResolvedValue({ id: 'pol-x', name: 'P', type, severity: 'HIGH', enabled: true });

      const res = await POST(makePostRequest({ ...validPolicyBody(), type }));
      expect(res.status).toBe(201);
    }
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
// two tests unmock it and stub its own dependencies (@/lib/auth, next/headers,
// @/lib/prisma) instead, following the pattern in tests/unit/auth-api.test.ts.
// That proves the route is really wired to the token path end to end, not
// just to a mock that returns a user object.
describe('GET /api/policies (real auth-api composition)', () => {
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

  afterEach(() => {
    vi.doMock('@/lib/auth-api', () => ({ resolveRequestUser: resolveRequestUserMock }));
  });

  it('(2c) returns 200 for a valid dsat_ token with no session', async () => {
    authMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_live_token' }));
    apiTokenFindUniqueMock.mockResolvedValue({
      id: 'tok-live',
      revokedAt: null,
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
      user: { id: 'user-9', githubLogin: 'agent', githubToken: 'gh_agent' },
    });

    const { GET } = await import('@/app/api/policies/route');
    const res = await GET();

    expect(res.status).toBe(401);
    expect(listPoliciesMock).not.toHaveBeenCalled();
  });
});
