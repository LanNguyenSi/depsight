// Route-level tests for GET /api/webhooks and POST /api/webhooks.
// Uses auth() (PATTERN B). assertPublicUrl (SSRF guard) is mocked at the
// module boundary so we can test the route's SSRF error handling in isolation.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, assertPublicUrlMock, webhookConfigFindMany, webhookConfigCreate } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    assertPublicUrlMock: vi.fn(),
    webhookConfigFindMany: vi.fn(),
    webhookConfigCreate: vi.fn(),
  }),
);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/net/safe-fetch', () => ({
  assertPublicUrl: assertPublicUrlMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'SsrfBlockedError';
    }
  },
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookConfig: {
      findMany: webhookConfigFindMany,
      create: webhookConfigCreate,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/webhooks/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/webhooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — GET /api/webhooks
// ---------------------------------------------------------------------------
describe('GET /api/webhooks', () => {
  beforeEach(() => {
    authMock.mockReset();
    webhookConfigFindMany.mockReset();
    assertPublicUrlMock.mockReset();
    webhookConfigCreate.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 200 with webhooks list on valid session', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    webhookConfigFindMany.mockResolvedValue([
      { id: 'wh-1', name: 'My Webhook', url: 'https://example.com/hook', events: ['cve.critical'], enabled: true, createdAt: new Date() },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { webhooks: object[] };
    expect(body.webhooks).toHaveLength(1);
    expect(webhookConfigFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/webhooks
// ---------------------------------------------------------------------------
describe('POST /api/webhooks', () => {
  beforeEach(() => {
    authMock.mockReset();
    webhookConfigFindMany.mockReset();
    assertPublicUrlMock.mockReset();
    webhookConfigCreate.mockReset();
  });

  it('(3) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ name: 'n', url: 'https://x.com', events: ['cve.critical'] }));

    expect(res.status).toBe(401);
  });

  it('(4) returns 400 when name is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ url: 'https://x.com', events: ['cve.critical'] }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('name, url, and events are required');
  });

  it('(4) returns 400 when url is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ name: 'My Hook', events: ['cve.critical'] }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('name, url, and events are required');
  });

  it('(4) returns 400 when events array is empty', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ name: 'My Hook', url: 'https://x.com', events: [] }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('name, url, and events are required');
  });

  it('(5) returns 400 with SsrfBlockedError message when assertPublicUrl rejects', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    // Import the mocked SsrfBlockedError class from the mock module
    const { SsrfBlockedError } = await import('@/lib/net/safe-fetch');
    assertPublicUrlMock.mockRejectedValue(
      new SsrfBlockedError('URL resolves to a non-public address'),
    );

    const res = await POST(
      makePostRequest({ name: 'Internal Hook', url: 'http://192.168.0.1/hook', events: ['cve.critical'] }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('URL resolves to a non-public address');
    expect(webhookConfigCreate).not.toHaveBeenCalled();
  });

  it('(6) returns 400 when events contain invalid names', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue({ url: new URL('https://example.com'), addresses: ['93.184.216.34'] });

    const res = await POST(
      makePostRequest({ name: 'My Hook', url: 'https://example.com', events: ['invalid.event', 'cve.critical'] }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('invalid.event');
    expect(body.error).toContain('Invalid events');
    expect(webhookConfigCreate).not.toHaveBeenCalled();
  });

  it('(7) returns 201 with webhook on valid request (assertPublicUrl passes)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue({ url: new URL('https://example.com/hook'), addresses: ['93.184.216.34'] });
    const createdWebhook = {
      id: 'wh-new',
      userId: 'user-1',
      name: 'My Hook',
      url: 'https://example.com/hook',
      events: ['cve.critical'],
      secret: null,
      enabled: true,
      createdAt: new Date(),
    };
    webhookConfigCreate.mockResolvedValue(createdWebhook);

    const res = await POST(
      makePostRequest({ name: 'My Hook', url: 'https://example.com/hook', events: ['cve.critical'] }),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { webhook: object };
    expect(body.webhook).toMatchObject({ id: 'wh-new', name: 'My Hook' });

    expect(assertPublicUrlMock).toHaveBeenCalledWith('https://example.com/hook');
    expect(webhookConfigCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', name: 'My Hook', url: 'https://example.com/hook' }),
      }),
    );
  });
});
