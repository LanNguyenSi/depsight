// Route-level tests for DELETE and PATCH /api/webhooks/[id].
// Uses auth() (PATTERN B) and ownership-guarded prisma calls.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  authMock,
  webhookConfigFindFirst,
  webhookConfigDelete,
  webhookConfigUpdate,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  webhookConfigFindFirst: vi.fn(),
  webhookConfigDelete: vi.fn(),
  webhookConfigUpdate: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookConfig: {
      findFirst: webhookConfigFindFirst,
      delete: webhookConfigDelete,
      update: webhookConfigUpdate,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { DELETE, PATCH } from '@/app/api/webhooks/[id]/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/webhooks/${id}`, { method: 'DELETE' });
}

function makePatchRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/webhooks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — DELETE /api/webhooks/[id]
// ---------------------------------------------------------------------------
describe('DELETE /api/webhooks/[id]', () => {
  beforeEach(() => {
    authMock.mockReset();
    webhookConfigFindFirst.mockReset();
    webhookConfigDelete.mockReset();
    webhookConfigUpdate.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await DELETE(makeDeleteRequest('wh-1'), makeParams('wh-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 404 when webhook does not belong to user (findFirst returns null)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    webhookConfigFindFirst.mockResolvedValue(null);

    const res = await DELETE(makeDeleteRequest('wh-other'), makeParams('wh-other'));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    expect(webhookConfigDelete).not.toHaveBeenCalled();
    expect(webhookConfigFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'wh-other', userId: 'user-1' }),
      }),
    );
  });

  it('(3) returns 200 with success:true and calls delete when webhook belongs to user', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const webhook = {
      id: 'wh-1',
      userId: 'user-1',
      name: 'My Hook',
      url: 'https://example.com/hook',
      enabled: true,
    };
    webhookConfigFindFirst.mockResolvedValue(webhook);
    webhookConfigDelete.mockResolvedValue(webhook);

    const res = await DELETE(makeDeleteRequest('wh-1'), makeParams('wh-1'));

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(webhookConfigDelete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wh-1' } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — PATCH /api/webhooks/[id]
// ---------------------------------------------------------------------------
describe('PATCH /api/webhooks/[id]', () => {
  beforeEach(() => {
    authMock.mockReset();
    webhookConfigFindFirst.mockReset();
    webhookConfigDelete.mockReset();
    webhookConfigUpdate.mockReset();
  });

  it('(4) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await PATCH(makePatchRequest('wh-1', { enabled: false }), makeParams('wh-1'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(5) returns 404 when webhook does not belong to user', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    webhookConfigFindFirst.mockResolvedValue(null);

    const res = await PATCH(makePatchRequest('wh-other', { enabled: true }), makeParams('wh-other'));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    expect(webhookConfigUpdate).not.toHaveBeenCalled();
  });

  it('(6) returns 200 and updates with explicit enabled=false', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const webhook = {
      id: 'wh-1',
      userId: 'user-1',
      name: 'My Hook',
      url: 'https://example.com/hook',
      enabled: true,
    };
    webhookConfigFindFirst.mockResolvedValue(webhook);
    const updated = { ...webhook, enabled: false };
    webhookConfigUpdate.mockResolvedValue(updated);

    const res = await PATCH(makePatchRequest('wh-1', { enabled: false }), makeParams('wh-1'));

    expect(res.status).toBe(200);
    const body = await res.json() as { webhook: { enabled: boolean } };
    expect(body.webhook.enabled).toBe(false);
    // body.enabled=false is passed explicitly, so update data.enabled must be false
    expect(webhookConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wh-1' },
        data: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('(7) toggles enabled true→false when enabled is absent from body', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    // webhook.enabled=true → toggle → false (body.enabled ?? !webhook.enabled = !true = false)
    const webhook = {
      id: 'wh-1',
      userId: 'user-1',
      name: 'My Hook',
      url: 'https://example.com/hook',
      enabled: true,
    };
    webhookConfigFindFirst.mockResolvedValue(webhook);
    const updated = { ...webhook, enabled: false };
    webhookConfigUpdate.mockResolvedValue(updated);

    const res = await PATCH(makePatchRequest('wh-1', {}), makeParams('wh-1'));

    expect(res.status).toBe(200);
    // enabled must be !webhook.enabled = !true = false
    expect(webhookConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('(8) toggles enabled false→true when enabled is absent from body', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    // webhook.enabled=false → toggle → true (body.enabled ?? !webhook.enabled = !false = true)
    const webhook = {
      id: 'wh-2',
      userId: 'user-1',
      name: 'Disabled Hook',
      url: 'https://example.com/hook',
      enabled: false,
    };
    webhookConfigFindFirst.mockResolvedValue(webhook);
    const updated = { ...webhook, enabled: true };
    webhookConfigUpdate.mockResolvedValue(updated);

    const res = await PATCH(makePatchRequest('wh-2', {}), makeParams('wh-2'));

    expect(res.status).toBe(200);
    // enabled must be !webhook.enabled = !false = true
    expect(webhookConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
      }),
    );
  });
});
