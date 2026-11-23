// Route-level tests for GET, POST, DELETE /api/slack.
// Uses auth() (PATTERN B). assertPublicUrl (SSRF guard) is mocked at the
// module boundary so we can test SSRF error handling in isolation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { DEFAULT_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';
import { slackConfigRateLimiter, SLACK_CONFIG_LIMIT_PER_HOUR } from '@/lib/rate-limit';

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

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'tok-123' } });

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(slackConfigFindUnique).not.toHaveBeenCalled();
    expect(slackConfigUpsert).not.toHaveBeenCalled();
    expect(slackConfigDeleteMany).not.toHaveBeenCalled();
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
    slackConfigRateLimiter.reset();
  });

  it('(4) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'tok-123' } });

    const res = await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(slackConfigFindUnique).not.toHaveBeenCalled();
    expect(slackConfigUpsert).not.toHaveBeenCalled();
    expect(slackConfigDeleteMany).not.toHaveBeenCalled();
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

  it('returns 400 Host did not resolve in time when assertPublicUrl rejects with a DNS timeout', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const { SafeFetchLimitError, DNS_UNREACHABLE_MESSAGE, DNS_BUSY_MESSAGE } =
      await import('@/lib/net/safe-fetch');
    assertPublicUrlMock.mockRejectedValue(
      new SafeFetchLimitError('timeout', 'DNS lookup timed out after 15000 ms'),
    );

    const res = await POST(makePostRequest({ webhookUrl: 'https://slow.example/slack' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(DNS_UNREACHABLE_MESSAGE);
    expect(body.error).toBe('Host did not resolve in time');
    // Distinct from the cap-full message.
    expect(body.error).not.toBe(DNS_BUSY_MESSAGE);
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });

  it('returns 400 Too many host checks in progress when assertPublicUrl rejects with dns_busy', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const { SafeFetchLimitError, DNS_UNREACHABLE_MESSAGE, DNS_BUSY_MESSAGE } =
      await import('@/lib/net/safe-fetch');
    assertPublicUrlMock.mockRejectedValue(
      new SafeFetchLimitError('dns_busy', 'Already 2 host name lookups in flight'),
    );

    const res = await POST(makePostRequest({ webhookUrl: 'https://busy.example/slack' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(DNS_BUSY_MESSAGE);
    expect(body.error).toBe('Too many host checks in progress, try again');
    // Distinct from the DNS timeout message.
    expect(body.error).not.toBe(DNS_UNREACHABLE_MESSAGE);
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
    // Save route: refuse at once when the lookup cap is full, never queue.
    expect(assertPublicUrlMock).toHaveBeenCalledWith('https://hooks.slack.com/x', {
      waitForSlot: false,
    });
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

  it('returns 401 and makes no database or downstream call when the session has a user but no id', async () => {
    authMock.mockResolvedValue({ user: { githubToken: 'tok-123' } });

    const res = await DELETE();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(slackConfigFindUnique).not.toHaveBeenCalled();
    expect(slackConfigUpsert).not.toHaveBeenCalled();
    expect(slackConfigDeleteMany).not.toHaveBeenCalled();
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

describe('POST /api/slack: request body cap', () => {
  beforeEach(() => {
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    slackConfigUpsert.mockReset();
    slackConfigRateLimiter.reset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
  });

  it('answers 413 for a body over the cap and saves nothing', async () => {
    const res = await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x', channel: 'x'.repeat(DEFAULT_JSON_BODY_BYTES) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(assertPublicUrlMock).not.toHaveBeenCalled();
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/slack: per-user rate limit
// ---------------------------------------------------------------------------
describe('POST /api/slack: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    slackConfigRateLimiter.reset();
    authMock.mockReset();
    assertPublicUrlMock.mockReset();
    slackConfigUpsert.mockReset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    assertPublicUrlMock.mockResolvedValue(undefined);
    slackConfigUpsert.mockResolvedValue({ id: 'slack-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('budgets 60 saves per user and hour', () => {
    expect(SLACK_CONFIG_LIMIT_PER_HOUR).toBe(60);
  });

  it('answers 429 with Retry-After on the (limit+1)th call and saves nothing', async () => {
    for (let i = 0; i < SLACK_CONFIG_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }))).status).toBe(200);
    }
    expect(slackConfigUpsert).toHaveBeenCalledTimes(SLACK_CONFIG_LIMIT_PER_HOUR);

    const res = await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(slackConfigUpsert).toHaveBeenCalledTimes(SLACK_CONFIG_LIMIT_PER_HOUR);
  });

  it('limits per user and does not count an unauthenticated request', async () => {
    authMock.mockResolvedValue(null);
    for (let i = 0; i < SLACK_CONFIG_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }))).status).toBe(401);
    }

    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    for (let i = 0; i < SLACK_CONFIG_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }))).status).toBe(200);
    }
    expect((await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }))).status).toBe(429);

    authMock.mockResolvedValue({ user: { id: 'someone-else' } });
    expect((await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }))).status).toBe(200);
  });

  it('runs the limiter before validation and the DNS check: an over-budget body answers 429 with neither called', async () => {
    for (let i = 0; i < SLACK_CONFIG_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ webhookUrl: 'https://hooks.slack.com/x' }))).status).toBe(200);
    }
    assertPublicUrlMock.mockClear();
    slackConfigUpsert.mockClear();

    // Passes the required webhookUrl check and carries a URL that would go to
    // the DNS check, with an invalid minSeverity that would fail validation
    // after it. The limiter is first, so this is 429 and neither DNS nor the
    // upsert runs (POST /api/slack has no count: it upserts the one row).
    const res = await POST(makePostRequest({
      webhookUrl: 'https://hooks.slack.com/x',
      minSeverity: 'SUPER_CRITICAL',
    }));

    expect(res.status).toBe(429);
    expect(assertPublicUrlMock).not.toHaveBeenCalled();
    expect(slackConfigUpsert).not.toHaveBeenCalled();
  });
});
