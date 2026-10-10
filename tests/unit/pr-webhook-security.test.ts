// Unit tests for lib/pr/webhook-security.ts: signature check, capped body
// read and the bounded replay guard.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createDeliveryGuard,
  hasWellFormedSignature,
  PR_WEBHOOK_DELIVERY_MAX_ENTRIES,
  PR_WEBHOOK_DELIVERY_TTL_MS,
  prWebhookDeliveries,
  readBodyCapped,
  verifyGitHubSignature,
} from '@/lib/pr/webhook-security';
import { PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR } from '@/lib/rate-limit';

const SECRET = 'a-webhook-secret';

function sign(body: Buffer, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyGitHubSignature', () => {
  const body = Buffer.from('{"action":"opened"}');

  it('accepts the HMAC of the exact bytes', () => {
    expect(verifyGitHubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('accepts an upper-case hex digest', () => {
    const header = 'sha256=' + sign(body).slice(7).toUpperCase();
    expect(verifyGitHubSignature(body, header, SECRET)).toBe(true);
  });

  it('rejects a digest made with another secret', () => {
    expect(verifyGitHubSignature(body, sign(body, 'other'), SECRET)).toBe(false);
  });

  it('rejects a digest of a different body', () => {
    expect(verifyGitHubSignature(body, sign(Buffer.from('{}')), SECRET)).toBe(false);
  });

  it('rejects a missing header and an empty secret', () => {
    expect(verifyGitHubSignature(body, null, SECRET)).toBe(false);
    expect(verifyGitHubSignature(body, sign(body), '')).toBe(false);
  });

  it.each([
    ['too short', 'sha256=abcd'],
    ['too long', sign(body) + '00'],
    ['wrong prefix', 'sha1=' + sign(body).slice(7)],
    ['not hex', 'sha256=' + 'z'.repeat(64)],
    ['empty', ''],
  ])('rejects a %s signature without throwing', (_name, header) => {
    expect(() => verifyGitHubSignature(body, header, SECRET)).not.toThrow();
    expect(verifyGitHubSignature(body, header, SECRET)).toBe(false);
  });
});

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Request('http://localhost/x', {
    method: 'POST',
    body: stream,
    headers,
    // @ts-expect-error duplex is required by undici for stream bodies
    duplex: 'half',
  });
}

describe('readBodyCapped', () => {
  it('returns the bytes of a body within the cap', async () => {
    const out = await readBodyCapped(streamRequest([Buffer.from('ab'), Buffer.from('cd')]), 4);
    expect(out?.toString()).toBe('abcd');
  });

  it('returns null once the streamed body passes the cap', async () => {
    const out = await readBodyCapped(streamRequest([Buffer.from('abc'), Buffer.from('de')]), 4);
    expect(out).toBeNull();
  });

  it('returns null from a declared Content-Length above the cap without reading', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': '5000' },
    });
    expect(await readBodyCapped(req, 10)).toBeNull();
  });

  it('ignores a Content-Length that is not a number and falls back to counting', async () => {
    const req = streamRequest([Buffer.from('abc')], { 'content-length': 'abc' });
    expect((await readBodyCapped(req, 10))?.toString()).toBe('abc');
  });

  it('returns an empty buffer for a request without a body', async () => {
    const out = await readBodyCapped(new Request('http://localhost/x', { method: 'POST' }), 10);
    expect(out?.length).toBe(0);
  });
});

describe('createDeliveryGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('remembers a key until it is forgotten', () => {
    const guard = createDeliveryGuard({ ttlMs: 1000, maxEntries: 10 });
    expect(guard.has('a')).toBe(false);
    guard.remember('a');
    expect(guard.has('a')).toBe(true);
    guard.forget('a');
    expect(guard.has('a')).toBe(false);
  });

  it('expires a key after the TTL', () => {
    vi.useFakeTimers();
    const guard = createDeliveryGuard({ ttlMs: 1000, maxEntries: 10 });
    guard.remember('a');
    vi.advanceTimersByTime(999);
    expect(guard.has('a')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(guard.has('a')).toBe(false);
  });

  it('keeps at most maxEntries keys, dropping the oldest first', () => {
    const guard = createDeliveryGuard({ ttlMs: 60_000, maxEntries: 2 });
    guard.remember('a');
    guard.remember('b');
    guard.remember('c');
    expect(guard.has('a')).toBe(false);
    expect(guard.has('b')).toBe(true);
    expect(guard.has('c')).toBe(true);
  });

  it('evicts every expired entry from the front, not only as many as the cap needs', () => {
    vi.useFakeTimers();
    const guard = createDeliveryGuard({ ttlMs: 1000, maxEntries: 2 });
    guard.remember('a');
    guard.remember('b');
    expect(guard.size()).toBe(2);
    vi.advanceTimersByTime(2000);
    guard.remember('c');
    // a and b are expired: both are dropped although the cap alone would only
    // have forced one of them out.
    expect(guard.size()).toBe(1);
    guard.remember('d');
    expect(guard.size()).toBe(2);
    expect(guard.has('c')).toBe(true);
    expect(guard.has('d')).toBe(true);
  });

  it('drops expired entries when a new key is remembered', () => {
    vi.useFakeTimers();
    const guard = createDeliveryGuard({ ttlMs: 1000, maxEntries: 10 });
    guard.remember('a');
    vi.advanceTimersByTime(2000);
    guard.remember('b');
    expect(guard.has('a')).toBe(false);
    expect(guard.has('b')).toBe(true);
  });

  it('reset clears everything', () => {
    const guard = createDeliveryGuard({ ttlMs: 1000, maxEntries: 10 });
    guard.remember('a');
    guard.reset();
    expect(guard.has('a')).toBe(false);
  });
});

describe('prWebhookDeliveries capacity', () => {
  it('holds both keys of every delivery the rate limit admits for the whole TTL', () => {
    const hours = PR_WEBHOOK_DELIVERY_TTL_MS / (60 * 60 * 1000);
    // Fixed hourly rate-limit windows: a TTL starting inside a window spans one more.
    expect(PR_WEBHOOK_DELIVERY_MAX_ENTRIES).toBeGreaterThanOrEqual(
      2 * PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR * (hours + 1),
    );
  });

  it('builds the production guard with that capacity', () => {
    expect(prWebhookDeliveries.capacity()).toBe(PR_WEBHOOK_DELIVERY_MAX_ENTRIES);
  });
});

describe('hasWellFormedSignature', () => {
  it('accepts sha256= plus 64 hex characters, either case', () => {
    expect(hasWellFormedSignature('sha256=' + 'a'.repeat(64))).toBe(true);
    expect(hasWellFormedSignature('sha256=' + 'A'.repeat(64))).toBe(true);
  });

  it.each([null, '', 'sha256=', 'sha256=' + 'a'.repeat(63), 'sha256=' + 'a'.repeat(65), 'sha1=' + 'a'.repeat(64), 'sha256=' + 'g'.repeat(64), ' sha256=' + 'a'.repeat(64)])(
    'rejects %j',
    (header) => {
      expect(hasWellFormedSignature(header)).toBe(false);
    },
  );
});
