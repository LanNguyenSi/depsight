// Route-level tests for GET /api/webhook-secrets and POST/DELETE
// /api/webhook-secrets/[repoId]: per-repository PR-scan webhook secrets,
// session and owner only. Prisma is an in-memory table that honours the
// ownership filters the routes pass, so a missing filter shows up as a
// cross-tenant success.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { authMock, findManyMock, findFirstMock, updateManyMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findManyMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: { repo: { findMany: findManyMock, findFirst: findFirstMock, updateMany: updateManyMock } },
}));

import { GET } from '@/app/api/webhook-secrets/route';
import { POST, DELETE, PATCH } from '@/app/api/webhook-secrets/[repoId]/route';
import { openWebhookSecret, sealWebhookSecret } from '@/lib/pr/webhook-secret';
import { webhookSecretRateLimiter, WEBHOOK_SECRET_LIMIT_PER_HOUR } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';

interface Row {
  id: string;
  userId: string;
  fullName: string;
  tracked: boolean;
  webhookSecretEnc: string | null;
  webhookSecretRotatedAt: Date | null;
  webhookScanForks?: boolean | null;
}

let table: Row[] = [];

function matches(row: Row, where: Partial<Row>): boolean {
  return Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
}

const params = (repoId: string) => ({ params: Promise.resolve({ repoId }) });
const req = (method: string, id = 'x', body?: unknown) =>
  new NextRequest(`http://localhost/api/webhook-secrets/${id}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });

function login(userId: string | null) {
  authMock.mockResolvedValue(userId ? { user: { id: userId } } : null);
}

describe('webhook secret routes', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
    delete process.env.WEBHOOK_SECRET_KEY;
    webhookSecretRateLimiter.reset();
    table = [
      { id: 'row-a', userId: 'user-a', fullName: 'acme/api', tracked: true, webhookSecretEnc: null, webhookSecretRotatedAt: null },
      { id: 'row-a2', userId: 'user-a', fullName: 'acme/web', tracked: false, webhookSecretEnc: null, webhookSecretRotatedAt: null },
      { id: 'row-b', userId: 'user-b', fullName: 'acme/api', tracked: true, webhookSecretEnc: 'sealed-b', webhookSecretRotatedAt: new Date('2026-01-01') },
    ];
    login('user-a');
    findManyMock.mockReset().mockImplementation(async ({ where }) => table.filter((r) => matches(r, where)));
    findFirstMock.mockReset().mockImplementation(async ({ where }) => table.find((r) => matches(r, where)) ?? null);
    updateManyMock.mockReset().mockImplementation(async ({ where, data }) => {
      const hit = table.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.GITHUB_WEBHOOK_SCAN_FORKS;
  });

  describe('GET /api/webhook-secrets', () => {
    it('answers 401 without a session', async () => {
      login(null);
      expect((await GET()).status).toBe(401);
      expect(findManyMock).not.toHaveBeenCalled();
    });

    it("lists only the caller's tracked repositories and never the secret", async () => {
      table[0].webhookSecretEnc = 'sealed-a-value';
      table[0].webhookSecretRotatedAt = new Date('2026-02-02');
      const res = await GET();
      const text = JSON.stringify(await res.json());

      expect(findManyMock.mock.calls[0][0].where).toEqual({ userId: 'user-a', tracked: true });
      expect(text).toContain('row-a');
      expect(text).not.toContain('row-b');
      expect(text).not.toContain('row-a2');
      expect(text).not.toContain('sealed-a-value');
      expect(JSON.parse(text).repos[0]).toMatchObject({ id: 'row-a', configured: true });
    });

    it("lists each row's own fork setting and the instance default", async () => {
      table[0].webhookScanForks = true;
      table.push({ id: 'row-a5', userId: 'user-a', fullName: 'acme/zz', tracked: true, webhookSecretEnc: null, webhookSecretRotatedAt: null, webhookScanForks: null });
      let body = (await (await GET()).json()) as {
        scanForksDefault: boolean;
        repos: { id: string; scanForks: boolean | null }[];
      };
      expect(body.scanForksDefault).toBe(false);
      expect(body.repos.find((r) => r.id === 'row-a')?.scanForks).toBe(true);
      expect(body.repos.find((r) => r.id === 'row-a5')?.scanForks).toBeNull();
      process.env.GITHUB_WEBHOOK_SCAN_FORKS = ' True ';
      body = await (await GET()).json();
      expect(body.scanForksDefault).toBe(true);
    });

    it('reports available from the presence of key material, the condition the mint route 503s on', async () => {
      expect((await (await GET()).json()).available).toBe(true);
      process.env.NEXTAUTH_SECRET = '  ';
      expect((await (await GET()).json()).available).toBe(false);
      delete process.env.NEXTAUTH_SECRET;
      expect((await (await GET()).json()).available).toBe(false);
      process.env.WEBHOOK_SECRET_KEY = 'dedicated-key';
      expect((await (await GET()).json()).available).toBe(true);
      delete process.env.WEBHOOK_SECRET_KEY;
    });

    it('reports usable only for a secret that opens under the current key material', async () => {
      table[0].webhookSecretEnc = sealWebhookSecret('s', 'row-a');
      table.push({
        id: 'row-a3',
        userId: 'user-a',
        fullName: 'acme/zeta',
        tracked: true,
        webhookSecretEnc: 'v1.AAAA.BBBB.CCCC',
        webhookSecretRotatedAt: new Date('2026-02-02'),
      });
      table.push({
        id: 'row-a4',
        userId: 'user-a',
        fullName: 'acme/beta',
        tracked: true,
        webhookSecretEnc: null,
        webhookSecretRotatedAt: null,
      });

      const { repos } = (await (await GET()).json()) as {
        repos: { id: string; configured: boolean; usable: boolean }[];
      };
      const byId = Object.fromEntries(repos.map((r) => [r.id, r]));
      expect(byId['row-a']).toMatchObject({ configured: true, usable: true });
      expect(byId['row-a3']).toMatchObject({ configured: true, usable: false });
      expect(byId['row-a4']).toMatchObject({ configured: false, usable: false });
    });

    it('reports a secret sealed under other key material as configured but not usable', async () => {
      table[0].webhookSecretEnc = sealWebhookSecret('s', 'row-a');
      process.env.NEXTAUTH_SECRET = 'rotated-key-material';
      const { repos } = (await (await GET()).json()) as {
        repos: { id: string; configured: boolean; usable: boolean }[];
      };
      expect(repos[0]).toMatchObject({ id: 'row-a', configured: true, usable: false });
    });

    it('never puts the plaintext or the sealed value in the listing', async () => {
      const sealed = sealWebhookSecret('plaintext-listing-secret', 'row-a');
      table[0].webhookSecretEnc = sealed;
      const text = JSON.stringify(await (await GET()).json());
      expect(text).not.toContain(sealed);
      expect(text).not.toContain('plaintext-listing-secret');
    });
  });

  describe('POST /api/webhook-secrets/[repoId]', () => {
    it('answers 401 without a session and writes nothing', async () => {
      login(null);
      const res = await POST(req('POST', 'row-a'), params('row-a'));
      expect(res.status).toBe(401);
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('mints a secret once, stores it sealed and answers no-store', async () => {
      const res = await POST(req('POST', 'row-a'), params('row-a'));
      const body = (await res.json()) as { secret: string; repository: string };

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.repository).toBe('acme/api');
      expect(table[0].webhookSecretEnc).not.toBeNull();
      expect(table[0].webhookSecretEnc).not.toContain(body.secret);
      expect(openWebhookSecret(table[0].webhookSecretEnc as string, 'row-a')).toBe(body.secret);
      expect(table[0].webhookSecretRotatedAt).toBeInstanceOf(Date);
    });

    it('rotates: a second call replaces the secret, and the old one no longer opens', async () => {
      const first = (await (await POST(req('POST', 'row-a'), params('row-a'))).json()) as { secret: string };
      const second = (await (await POST(req('POST', 'row-a'), params('row-a'))).json()) as { secret: string };

      expect(second.secret).not.toBe(first.secret);
      expect(openWebhookSecret(table[0].webhookSecretEnc as string, 'row-a')).toBe(second.secret);
    });

    it("answers 404 for another user's repository and leaves it unchanged", async () => {
      const res = await POST(req('POST', 'row-b'), params('row-b'));
      expect(res.status).toBe(404);
      expect(table[2].webhookSecretEnc).toBe('sealed-b');
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('keeps the owner in the write filter, not only in the read', async () => {
      await POST(req('POST', 'row-a'), params('row-a'));
      expect(updateManyMock.mock.calls[0][0].where).toEqual({ id: 'row-a', userId: 'user-a', tracked: true });
    });

    it('answers 404 when the row stops being the live owner row between read and write', async () => {
      updateManyMock.mockResolvedValueOnce({ count: 0 });
      const res = await POST(req('POST', 'row-a'), params('row-a'));
      expect(res.status).toBe(404);
    });

    it('answers 404 for an unknown repository id', async () => {
      expect((await POST(req('POST', 'nope'), params('nope'))).status).toBe(404);
    });

    it('answers 409 for an untracked repository and stores nothing', async () => {
      const res = await POST(req('POST', 'row-a2'), params('row-a2'));
      expect(res.status).toBe(409);
      expect(table[1].webhookSecretEnc).toBeNull();
    });

    it('answers 503 when no sealing key is configured', async () => {
      delete process.env.NEXTAUTH_SECRET;
      const res = await POST(req('POST', 'row-a'), params('row-a'));
      expect(res.status).toBe(503);
      expect(table[0].webhookSecretEnc).toBeNull();
    });

    it('answers 429 once the caller passes the hourly budget', async () => {
      for (let i = 0; i < WEBHOOK_SECRET_LIMIT_PER_HOUR; i++) {
        expect((await POST(req('POST', 'row-a'), params('row-a'))).status).toBe(200);
      }
      const limited = await POST(req('POST', 'row-a'), params('row-a'));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    });
  });

  describe('PATCH /api/webhook-secrets/[repoId]', () => {
    const patch = (id: string, body: unknown) => PATCH(req('PATCH', id, body), params(id));

    it('answers 401 without a session and writes nothing', async () => {
      login(null);
      expect((await patch('row-a', { scanForks: true })).status).toBe(401);
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('stores true, false and null on an owned tracked row', async () => {
      for (const value of [true, false, null]) {
        const res = await patch('row-a', { scanForks: value });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, scanForks: value });
        expect(table[0].webhookScanForks).toBe(value);
      }
    });

    it("answers 404 for another user's row and leaves it unchanged", async () => {
      table[2].webhookScanForks = null;
      const res = await patch('row-b', { scanForks: true });
      expect(res.status).toBe(404);
      expect(table[2].webhookScanForks).toBeNull();
    });

    it('keeps the owner and tracked in the write filter', async () => {
      await patch('row-a', { scanForks: true });
      expect(updateManyMock.mock.calls[0][0].where).toEqual({ id: 'row-a', userId: 'user-a', tracked: true });
    });

    it('answers 404 for an untracked row', async () => {
      expect((await patch('row-a2', { scanForks: true })).status).toBe(404);
    });

    it.each([
      ['a string', { scanForks: 'true' }],
      ['a number', { scanForks: 1 }],
      ['a missing key', {}],
      ['a wrong key', { fork: true }],
      ['an array body', [true]],
      ['a null body', null],
      ['malformed JSON', '{nope'],
    ])('answers 400 for %s and writes nothing', async (_n, body) => {
      const res = await patch('row-a', body);
      expect(res.status).toBe(400);
      expect(updateManyMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/webhook-secrets/[repoId]', () => {
    it('answers 401 without a session', async () => {
      login(null);
      const res = await DELETE(req('DELETE', 'row-a'), params('row-a'));
      expect(res.status).toBe(401);
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it('clears the secret of an owned row', async () => {
      table[0].webhookSecretEnc = 'sealed-a';
      table[0].webhookSecretRotatedAt = new Date();
      const res = await DELETE(req('DELETE', 'row-a'), params('row-a'));
      expect(res.status).toBe(200);
      expect(table[0].webhookSecretEnc).toBeNull();
      expect(table[0].webhookSecretRotatedAt).toBeNull();
    });

    it("answers 404 for another user's row and leaves its secret", async () => {
      const res = await DELETE(req('DELETE', 'row-b'), params('row-b'));
      expect(res.status).toBe(404);
      expect(table[2].webhookSecretEnc).toBe('sealed-b');
      expect(updateManyMock.mock.calls[0][0].where).toEqual({ id: 'row-b', userId: 'user-a' });
    });
  });
});
