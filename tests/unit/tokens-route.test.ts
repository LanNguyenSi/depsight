// Route-level tests for GET /api/tokens and POST /api/tokens.
// Uses auth() (PATTERN B) — session-only, never resolveRequestUser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, apiTokenFindMany, apiTokenCreate, apiTokenCount } = vi.hoisted(() => ({
  authMock: vi.fn(),
  apiTokenFindMany: vi.fn(),
  apiTokenCreate: vi.fn(),
  apiTokenCount: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiToken: {
      findMany: apiTokenFindMany,
      create: apiTokenCreate,
      count: apiTokenCount,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/tokens/route';
import { NextRequest } from 'next/server';
import { DEFAULT_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';
import {
  apiTokenCreateRateLimiter,
  API_TOKEN_CREATE_LIMIT_PER_HOUR,
  MAX_API_TOKENS_PER_USER,
} from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests — GET /api/tokens
// ---------------------------------------------------------------------------
describe('GET /api/tokens', () => {
  beforeEach(() => {
    authMock.mockReset();
    apiTokenFindMany.mockReset();
    apiTokenCreate.mockReset();
    apiTokenCount.mockReset().mockResolvedValue(0);
    apiTokenCreateRateLimiter.reset();
  });

  it('(1) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(2) returns 200 with tokens list (raw token value never returned)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const now = new Date('2026-01-01T00:00:00Z');
    apiTokenFindMany.mockResolvedValue([
      { id: 'tok-1', name: 'ci-token', scope: 'WRITE', createdAt: now, lastUsedAt: null, revokedAt: null },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: object[] };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({ id: 'tok-1', name: 'ci-token', scope: 'WRITE' });

    // The raw token value must NEVER appear in the response.
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('dsat_');
    expect((body.tokens[0] as Record<string, unknown>)['token']).toBeUndefined();

    // Verify prisma was called with correct userId filter and that the
    // select includes scope, so the token list can show it.
    expect(apiTokenFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        select: expect.objectContaining({ scope: true }),
      }),
    );
    // The query itself must not read the token column (a later change that
    // returns the select result as-is would otherwise leak the stored value).
    const select = apiTokenFindMany.mock.calls[0][0].select as Record<string, unknown>;
    expect(Object.keys(select)).not.toContain('token');
  });

  it('(2) SECURITY: route uses auth() only — calling with no auth returns 401 (dsat_ tokens cannot manage tokens)', async () => {
    // auth() returning null simulates a dsat_ bearer token request arriving (auth() ignores Bearer headers).
    authMock.mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/tokens
// ---------------------------------------------------------------------------
describe('POST /api/tokens', () => {
  beforeEach(() => {
    authMock.mockReset();
    apiTokenFindMany.mockReset();
    apiTokenCreate.mockReset();
    apiTokenCount.mockReset().mockResolvedValue(0);
    apiTokenCreateRateLimiter.reset();
  });

  it('(3) returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makePostRequest({ name: 'ci-token' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('(4) returns 400 when name field is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('A token name is required');
  });

  it('(5) returns 400 when name is an empty string', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ name: '' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('A token name is required');
  });

  it('(5) returns 400 when name is whitespace-only', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ name: '   ' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('A token name is required');
  });

  it('(6) returns 400 when name exceeds 100 characters', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ name: 'a'.repeat(101) }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Token name is too long (max 100 characters)');
  });

  it('(7) returns 201 with dsat_ token and record on valid request, defaulting scope to WRITE when omitted', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const now = new Date('2026-01-01T00:00:00Z');
    apiTokenCreate.mockResolvedValue({ id: 'tok-new', name: 'ci-token', scope: 'WRITE', createdAt: now });

    const res = await POST(makePostRequest({ name: 'ci-token' }));

    expect(res.status).toBe(201);
    const body = await res.json() as { token: string; record: { id: string; name: string; createdAt: string } };

    // Token must start with dsat_ prefix followed by 64 hex chars.
    expect(body.token).toMatch(/^dsat_[0-9a-f]{64}$/);
    expect(body.record.id).toBe('tok-new');
    expect(body.record.name).toBe('ci-token');

    // Prisma create must be called with the correct userId and a scope
    // defaulting to WRITE (today's behaviour) when the caller omits it, so
    // any pre-existing caller of this API that does not yet send `scope`
    // keeps minting full-access tokens exactly as before.
    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', name: 'ci-token', scope: 'WRITE' }),
      }),
    );
  });

  it('(7a) stores only the SHA-256 of the minted token and returns the raw value once', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    apiTokenCreate.mockResolvedValue({
      id: 'tok-h',
      name: 'ci-token',
      scope: 'WRITE',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const res = await POST(makePostRequest({ name: 'ci-token' }));

    expect(res.status).toBe(201);
    const body = await res.json() as { token: string; record: Record<string, unknown> };
    const arg = apiTokenCreate.mock.calls[0][0] as {
      data: { token: string };
      select: Record<string, unknown>;
    };
    // The database write holds the hash of the returned token, not the token.
    expect(arg.data.token).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(arg.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(arg.data.token).not.toBe(body.token);
    expect(arg.data.token.startsWith('dsat_')).toBe(false);
    // The created row is read back without the token column, and neither the
    // record nor anything but the one-time `token` field carries the value.
    expect(Object.keys(arg.select)).not.toContain('token');
    expect(body.record).not.toHaveProperty('token');
    expect(JSON.stringify(body.record)).not.toContain(body.token);
  });

  it('(7b) accepts an explicit READ scope and persists it', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const now = new Date('2026-01-01T00:00:00Z');
    apiTokenCreate.mockResolvedValue({ id: 'tok-ro', name: 'mcp-readonly', scope: 'READ', createdAt: now });

    const res = await POST(makePostRequest({ name: 'mcp-readonly', scope: 'READ' }));

    expect(res.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'READ' }),
      }),
    );
  });

  it('(7c) accepts an explicit WRITE scope and persists it', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const now = new Date('2026-01-01T00:00:00Z');
    apiTokenCreate.mockResolvedValue({ id: 'tok-rw', name: 'mcp-full', scope: 'WRITE', createdAt: now });

    const res = await POST(makePostRequest({ name: 'mcp-full', scope: 'WRITE' }));

    expect(res.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'WRITE' }),
      }),
    );
  });

  it('(7d) returns 400 when scope is an invalid value', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await POST(makePostRequest({ name: 'ci-token', scope: 'ADMIN' }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid token scope (expected READ or WRITE)');
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it('(7) name with exactly 100 chars is accepted (boundary)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    const now = new Date('2026-01-01T00:00:00Z');
    apiTokenCreate.mockResolvedValue({ id: 'tok-100', name: 'a'.repeat(100), createdAt: now });

    const res = await POST(makePostRequest({ name: 'a'.repeat(100) }));

    expect(res.status).toBe(201);
  });

  it('returns 400 when request body is invalid JSON (catch callback covered)', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    // Send a raw non-JSON body so req.json() rejects → caught → {} → name = ''
    const req = new NextRequest('http://localhost/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-valid-json',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('A token name is required');
  });
});

describe('POST /api/tokens: request body cap', () => {
  beforeEach(() => {
    authMock.mockReset();
    apiTokenCreate.mockReset();
    apiTokenCount.mockReset().mockResolvedValue(0);
    apiTokenCreateRateLimiter.reset();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
  });

  it('answers 413 for a body over the cap and mints nothing', async () => {
    const res = await POST(
      makePostRequest({ name: 'ci-token', padding: 'x'.repeat(DEFAULT_JSON_BODY_BYTES) }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it('keeps treating malformed JSON as an empty body (400 name required)', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A token name is required' });
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/tokens: per-user rate limit
// ---------------------------------------------------------------------------
describe('POST /api/tokens: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    apiTokenCreateRateLimiter.reset();
    authMock.mockReset();
    apiTokenCreate.mockReset();
    apiTokenCount.mockReset().mockResolvedValue(0);
    apiTokenCreate.mockResolvedValue({ id: 'tok-new' });
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('budgets 30 mints per user and hour', () => {
    expect(API_TOKEN_CREATE_LIMIT_PER_HOUR).toBe(30);
  });

  it('answers 429 with Retry-After on the (limit+1)th call and mints nothing', async () => {
    for (let i = 0; i < API_TOKEN_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ name: `ci-${i}` }))).status).toBe(201);
    }
    expect(apiTokenCreate).toHaveBeenCalledTimes(API_TOKEN_CREATE_LIMIT_PER_HOUR);

    const res = await POST(makePostRequest({ name: 'one-too-many' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(apiTokenCreate).toHaveBeenCalledTimes(API_TOKEN_CREATE_LIMIT_PER_HOUR);
  });

  it('limits per user and does not count an unauthenticated request', async () => {
    authMock.mockResolvedValue(null);
    for (let i = 0; i < API_TOKEN_CREATE_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makePostRequest({ name: 'ci-token' }))).status).toBe(401);
    }

    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    for (let i = 0; i < API_TOKEN_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ name: 'ci-token' }))).status).toBe(201);
    }
    expect((await POST(makePostRequest({ name: 'ci-token' }))).status).toBe(429);

    authMock.mockResolvedValue({ user: { id: 'someone-else' } });
    expect((await POST(makePostRequest({ name: 'ci-token' }))).status).toBe(201);
  });

  it('runs the limiter before validation and the count: an over-budget empty-name body answers 429 with no count and no mint', async () => {
    for (let i = 0; i < API_TOKEN_CREATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makePostRequest({ name: 'ci-token' }))).status).toBe(201);
    }
    apiTokenCount.mockClear();
    apiTokenCreate.mockClear();

    // A body missing the required name would fail validation (400) if the
    // limiter ran after validation; the limiter is first, so this is 429.
    const res = await POST(makePostRequest({}));

    expect(res.status).toBe(429);
    expect(apiTokenCount).not.toHaveBeenCalled();
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/tokens: per-user active-token cap
// ---------------------------------------------------------------------------
describe('POST /api/tokens: per-user active-token cap', () => {
  beforeEach(() => {
    authMock.mockReset();
    apiTokenCreate.mockReset();
    apiTokenCount.mockReset();
    apiTokenCreateRateLimiter.reset();
    apiTokenCreate.mockResolvedValue({ id: 'tok-new' });
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
  });

  it('answers 409 with a message naming the cap at the cap and mints nothing', async () => {
    apiTokenCount.mockResolvedValue(MAX_API_TOKENS_PER_USER);

    const res = await POST(makePostRequest({ name: 'ci-token' }));

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(`A user can have at most ${MAX_API_TOKENS_PER_USER} active API tokens`);
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });

  it('mints successfully one below the cap', async () => {
    apiTokenCount.mockResolvedValue(MAX_API_TOKENS_PER_USER - 1);

    const res = await POST(makePostRequest({ name: 'ci-token' }));

    expect(res.status).toBe(201);
    expect(apiTokenCreate).toHaveBeenCalledTimes(1);
  });

  it('counts only active (not revoked) tokens of the caller, so revoking frees room', async () => {
    apiTokenCount.mockResolvedValue(0);
    await POST(makePostRequest({ name: 'ci-token' }));
    expect(apiTokenCount).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
    });
  });
});
