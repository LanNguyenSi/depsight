// Route-level tests for GET, PUT, DELETE /api/policies/[id].
// Uses resolveRequestUser() (session or dsat_ bearer token) and the policy
// service boundary.
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
vi.mock('@/lib/auth-api', () => ({ resolveRequestUser: resolveRequestUserMock }));
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

const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

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

  it('(1b) returns 401 for a revoked dsat_ token (resolveRequestUser returns null)', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(1c) returns 200 when authenticated via a valid dsat_ token and no session', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    getPolicyByIdMock.mockResolvedValue({
      id: 'pol-1',
      name: 'Block GPL',
      type: 'LICENSE_DENY',
      severity: 'HIGH',
      enabled: true,
    });

    const res = await GET(makeGetRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(200);
    expect(getPolicyByIdMock).toHaveBeenCalledWith('user-1', 'pol-1');
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

  it('(4b) returns 401 for a revoked dsat_ token (resolveRequestUser returns null)', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await PUT(makePutRequest('pol-1', { name: 'Updated' }), makeParams('pol-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(4c) returns 200 when authenticated via a valid dsat_ token and no session', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    updatePolicyMock.mockResolvedValue({ id: 'pol-1', name: 'Updated', type: 'LICENSE_DENY', severity: 'HIGH', enabled: true });

    const res = await PUT(makePutRequest('pol-1', { name: 'Updated' }), makeParams('pol-1'));

    expect(res.status).toBe(200);
    expect(updatePolicyMock).toHaveBeenCalledWith('user-1', 'pol-1', expect.anything());
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
    const validTypes = ['LICENSE_DENY', 'LICENSE_ALLOW_ONLY', 'CVE_MIN_SEVERITY', 'DEPENDENCY_MAX_AGE'];
    for (const type of validTypes) {
      resolveRequestUserMock.mockResolvedValue(mockUser);
      updatePolicyMock.mockResolvedValue({ id: 'pol-1', name: 'P', type, severity: 'HIGH', enabled: true });

      const res = await PUT(
        makePutRequest('pol-1', { type }),
        makeParams('pol-1'),
      );
      expect(res.status).toBe(200);
    }
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

  it('(11b) returns 401 for a revoked dsat_ token (resolveRequestUser returns null)', async () => {
    resolveRequestUserMock.mockResolvedValue(null);

    const res = await DELETE(makeDeleteRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(11c) returns 200 when authenticated via a valid dsat_ token and no session', async () => {
    resolveRequestUserMock.mockResolvedValue(mockUser);
    deletePolicyMock.mockResolvedValue(true);

    const res = await DELETE(makeDeleteRequest('pol-1'), makeParams('pol-1'));

    expect(res.status).toBe(200);
    expect(deletePolicyMock).toHaveBeenCalledWith('user-1', 'pol-1');
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
  });
});
