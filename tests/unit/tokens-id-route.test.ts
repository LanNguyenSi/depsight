// Route-level tests for DELETE /api/tokens/[id].
// Uses auth() (PATTERN B) — session-only.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, apiTokenUpdateMany } = vi.hoisted(() => ({
  authMock: vi.fn(),
  apiTokenUpdateMany: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiToken: {
      updateMany: apiTokenUpdateMany,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { DELETE } from '@/app/api/tokens/[id]/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeDeleteRequest(tokenId: string): NextRequest {
  return new NextRequest(`http://localhost/api/tokens/${tokenId}`, { method: 'DELETE' });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests — DELETE /api/tokens/[id]
// ---------------------------------------------------------------------------
describe('DELETE /api/tokens/[id]', () => {
  beforeEach(() => {
    authMock.mockReset();
    apiTokenUpdateMany.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await DELETE(makeDeleteRequest('tok-1'), makeParams('tok-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 200 {ok:true} when token belongs to user and is active', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    // updateMany returns count=1 → token was found and revoked
    apiTokenUpdateMany.mockResolvedValue({ count: 1 });

    const res = await DELETE(makeDeleteRequest('tok-1'), makeParams('tok-1'));

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // where clause must include userId to prevent IDOR, and revokedAt: null to keep it idempotent
    expect(apiTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'tok-1', userId: 'user-1', revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it('(3) returns 404 when token id does not belong to user (IDOR guard)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    // updateMany returns count=0 → token does not belong to this user
    apiTokenUpdateMany.mockResolvedValue({ count: 0 });

    const res = await DELETE(makeDeleteRequest('tok-other-user'), makeParams('tok-other-user'));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Token not found');

    // Verify userId was included in the where clause (not just id), preventing cross-user access
    expect(apiTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
  });

  it('(4) returns 404 when token is already revoked (idempotent — does not un-revoke)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    // The where clause includes revokedAt: null, so an already-revoked token won't match → count=0
    apiTokenUpdateMany.mockResolvedValue({ count: 0 });

    const res = await DELETE(makeDeleteRequest('tok-already-revoked'), makeParams('tok-already-revoked'));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Token not found');

    // Confirm revokedAt: null guard is in the where clause
    expect(apiTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      }),
    );
  });
});
