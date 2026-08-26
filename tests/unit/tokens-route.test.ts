// Route-level tests for GET /api/tokens and POST /api/tokens.
// Uses auth() (PATTERN B) — session-only, never resolveRequestUser.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, apiTokenFindMany, apiTokenCreate } = vi.hoisted(() => ({
  authMock: vi.fn(),
  apiTokenFindMany: vi.fn(),
  apiTokenCreate: vi.fn(),
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
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/tokens/route';
import { NextRequest } from 'next/server';

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
    expect(body.error).toBe('invalid scope');
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
