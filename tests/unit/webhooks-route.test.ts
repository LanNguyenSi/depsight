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
// Only assertPublicUrl is replaced; the error classes and the route-facing
// messages come from the real module so the route's instanceof checks and
// message constants are the production ones.
vi.mock('@/lib/net/safe-fetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/net/safe-fetch')>(
    '@/lib/net/safe-fetch',
  );
  return { ...actual, assertPublicUrl: assertPublicUrlMock };
});
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
import { DEFAULT_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';

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

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'tok-123' } });

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(webhookConfigFindMany).not.toHaveBeenCalled();
    expect(webhookConfigCreate).not.toHaveBeenCalled();
    expect(assertPublicUrlMock).not.toHaveBeenCalled();
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

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'tok-123' } });

    const res = await POST(makePostRequest({ name: 'n', url: 'https://x.com', events: ['cve.critical'] }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(webhookConfigFindMany).not.toHaveBeenCalled();
    expect(webhookConfigCreate).not.toHaveBeenCalled();
    expect(assertPublicUrlMock).not.toHaveBeenCalled();
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

  it('returns 400 Host did not resolve in time when assertPublicUrl rejects with a DNS timeout', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const { SafeFetchLimitError, DNS_UNREACHABLE_MESSAGE, DNS_BUSY_MESSAGE } =
      await import('@/lib/net/safe-fetch');
    assertPublicUrlMock.mockRejectedValue(
      new SafeFetchLimitError('timeout', 'DNS lookup timed out after 15000 ms'),
    );

    const res = await POST(
      makePostRequest({ name: 'Slow Hook', url: 'https://slow.example/hook', events: ['cve.critical'] }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(DNS_UNREACHABLE_MESSAGE);
    expect(body.error).toBe('Host did not resolve in time');
    // Distinct from the cap-full message.
    expect(body.error).not.toBe(DNS_BUSY_MESSAGE);
    expect(webhookConfigCreate).not.toHaveBeenCalled();
  });

  it('returns 400 Too many host checks in progress when assertPublicUrl rejects with dns_busy', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const { SafeFetchLimitError, DNS_UNREACHABLE_MESSAGE, DNS_BUSY_MESSAGE } =
      await import('@/lib/net/safe-fetch');
    assertPublicUrlMock.mockRejectedValue(
      new SafeFetchLimitError('dns_busy', 'Already 2 host name lookups in flight'),
    );

    const res = await POST(
      makePostRequest({ name: 'Busy Hook', url: 'https://busy.example/hook', events: ['cve.critical'] }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(DNS_BUSY_MESSAGE);
    expect(body.error).toBe('Too many host checks in progress, try again');
    // Distinct from the DNS timeout message.
    expect(body.error).not.toBe(DNS_UNREACHABLE_MESSAGE);
    expect(webhookConfigCreate).not.toHaveBeenCalled();
  });

  it('returns 400 Invalid URL format when assertPublicUrl rejects with a non-SSRF, non-limit error', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockRejectedValue(new Error('some unexpected failure'));

    const res = await POST(
      makePostRequest({ name: 'Bad Hook', url: 'not-a-url', events: ['cve.critical'] }),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid URL format');
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

// ---------------------------------------------------------------------------
// Tests: request body cap and the write-only signing secret
// ---------------------------------------------------------------------------
const PUBLIC_KEYS = ['createdAt', 'enabled', 'events', 'id', 'name', 'url'];

/** A prisma stand-in that honours `select`, so the response shows what a real query returns. */
function applySelect(row: Record<string, unknown>, select: Record<string, boolean> | undefined) {
  if (!select) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => select[k]));
}

const fullRow = {
  id: 'wh-new',
  userId: 'user-1',
  name: 'My Hook',
  url: 'https://example.com/hook',
  secret: 'whsec_super_secret',
  events: ['cve.critical'],
  enabled: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('POST /api/webhooks: request body cap', () => {
  beforeEach(() => {
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    webhookConfigCreate.mockReset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue({
      url: new URL('https://example.com/hook'),
      addresses: ['93.184.216.34'],
    });
  });

  it('answers 413 for a body over the cap and creates nothing', async () => {
    const res = await POST(
      makePostRequest({
        name: 'My Hook',
        url: 'https://example.com/hook',
        events: ['cve.critical'],
        secret: 'x'.repeat(DEFAULT_JSON_BODY_BYTES),
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(assertPublicUrlMock).not.toHaveBeenCalled();
    expect(webhookConfigCreate).not.toHaveBeenCalled();
  });
});

describe('webhook responses never carry the signing secret', () => {
  beforeEach(() => {
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    webhookConfigCreate.mockReset();
    webhookConfigFindMany.mockReset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue({
      url: new URL('https://example.com/hook'),
      addresses: ['93.184.216.34'],
    });
  });

  it('POST returns exactly the public keys, with the secret stored but not echoed', async () => {
    webhookConfigCreate.mockImplementation(
      async (args: { select?: Record<string, boolean> }) => applySelect(fullRow, args.select),
    );

    const res = await POST(
      makePostRequest({
        name: 'My Hook',
        url: 'https://example.com/hook',
        events: ['cve.critical'],
        secret: 'whsec_super_secret',
      }),
    );

    expect(res.status).toBe(201);
    const { webhook } = await res.json() as { webhook: Record<string, unknown> };
    expect(Object.keys(webhook).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(webhook)).not.toContain('whsec_super_secret');
    expect(webhookConfigCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ secret: 'whsec_super_secret' }),
      }),
    );
  });

  it('GET returns exactly the public keys', async () => {
    webhookConfigFindMany.mockImplementation(
      async (args: { select?: Record<string, boolean> }) => [applySelect(fullRow, args.select)],
    );

    const res = await GET();

    const { webhooks } = await res.json() as { webhooks: Record<string, unknown>[] };
    expect(Object.keys(webhooks[0]).sort()).toEqual(PUBLIC_KEYS);
  });
});
