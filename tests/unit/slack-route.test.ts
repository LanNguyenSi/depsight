// Route-level tests for GET, POST, DELETE /api/slack.
// Uses auth() (PATTERN B). assertPublicUrl (SSRF guard) is mocked at the
// module boundary so we can test SSRF error handling in isolation.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  authMock,
  assertPublicUrlMock,
  slackConfigFindUnique,
  slackConfigUpsert,
  slackConfigDeleteMany,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  assertPublicUrlMock: vi.fn(),
  slackConfigFindUnique: vi.fn(),
  slackConfigUpsert: vi.fn(),
  slackConfigDeleteMany: vi.fn(),
}));

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
    slackConfig: {
      findUnique: slackConfigFindUnique,
      upsert: slackConfigUpsert,
      deleteMany: slackConfigDeleteMany,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST, DELETE } from '@/app/api/slack/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — GET /api/slack
// ---------------------------------------------------------------------------
describe('GET /api/slack', () => {
  beforeEach(() => {
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    slackConfigFindUnique.mockReset();
    slackConfigUpsert.mockReset();
    slackConfigDeleteMany.mockReset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 200 with config when session is valid and config exists', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const config = {
      id: 'slack-1',
      userId: 'user-1',
      webhookUrl: 'https://hooks.slack.com/services/xxx',
      channel: '#alerts',
      minSeverity: 'HIGH',
      enabled: true,
    };
    slackConfigFindUnique.mockResolvedValue(config);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { config: object };
    expect(body.config).toMatchObject({ id: 'slack-1' });
    expect(slackConfigFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('(3) returns 200 with config:null when no Slack config exists for user', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    slackConfigFindUnique.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { config: null };
    expect(body.config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/slack
// ---------------------------------------------------------------------------
describe('POST /api/slack', () => {
  beforeEach(() => {
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    slackConfigFindUnique.mockReset();
    slackConfigUpsert.mockReset();
    slackConfigDeleteMany.mockReset();
  });

  it('(4) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(5) returns 400 when webhookUrl is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('webhookUrl is required');
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });

  it('(6) returns 400 with SSRF message when assertPublicUrl throws SsrfBlockedError', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const { SsrfBlockedError } = await import('@/lib/net/safe-fetch');
    assertPublicUrlMock.mockRejectedValue(
      new SsrfBlockedError('URL resolves to a non-public address'),
    );

    const res = await POST(makePostRequest({ webhookUrl: 'http://169.254.169.254/slack' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('URL resolves to a non-public address');
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });

  it('(7) returns 400 with generic format message when assertPublicUrl throws non-SSRF error', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockRejectedValue(new Error('DNS resolution failed'));

    const res = await POST(makePostRequest({ webhookUrl: 'not-a-url' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid webhookUrl format');
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });

  it('(8) returns 400 when minSeverity is an invalid enum value', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue(undefined);

    const res = await POST(makePostRequest({
      webhookUrl: 'https://hooks.slack.com/x',
      minSeverity: 'SUPER_CRITICAL',
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid minSeverity');
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });

  it('(9) returns 200 with upserted config on valid request', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue(undefined);
    const upsertedConfig = {
      id: 'slack-1',
      userId: 'user-1',
      webhookUrl: 'https://hooks.slack.com/x',
      channel: '#security',
      minSeverity: 'HIGH',
      enabled: true,
    };
    slackConfigUpsert.mockResolvedValue(upsertedConfig);

    const res = await POST(makePostRequest({
      webhookUrl: 'https://hooks.slack.com/x',
      channel: '#security',
      minSeverity: 'HIGH',
      enabled: true,
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { config: object };
    expect(body.config).toMatchObject({ id: 'slack-1' });
    expect(slackConfigUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        create: expect.objectContaining({
          userId: 'user-1',
          webhookUrl: 'https://hooks.slack.com/x',
          minSeverity: 'HIGH',
        }),
        update: expect.objectContaining({
          webhookUrl: 'https://hooks.slack.com/x',
          minSeverity: 'HIGH',
        }),
      }),
    );
  });

  it('(10) accepts all valid minSeverity enum values (CRITICAL, HIGH, MEDIUM, LOW)', async () => {
    const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    for (const minSeverity of validSeverities) {
      authMock.mockResolvedValue({ user: { id: 'user-1' } });
      assertPublicUrlMock.mockResolvedValue(undefined);
      slackConfigUpsert.mockResolvedValue({ id: 'slack-x', minSeverity });

      const res = await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x', minSeverity }));
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/slack
// ---------------------------------------------------------------------------
describe('DELETE /api/slack', () => {
  beforeEach(() => {
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    slackConfigFindUnique.mockReset();
    slackConfigUpsert.mockReset();
    slackConfigDeleteMany.mockReset();
  });

  it('(11) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await DELETE();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(12) returns 200 with success:true and calls deleteMany scoped to userId', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    slackConfigDeleteMany.mockResolvedValue({ count: 1 });

    const res = await DELETE();

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(slackConfigDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });
});
