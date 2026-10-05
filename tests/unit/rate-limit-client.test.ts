import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  parseRetryAfterSeconds,
  readRateLimit,
  scanAllStopMessage,
} from '@/lib/rate-limit-client';
import { getTranslations, type Locale } from '@/lib/i18n/translations';
import { interpolate } from '@/lib/i18n/context';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('parseRetryAfterSeconds', () => {
  it('prefers the body retryAfterSeconds over the header', () => {
    expect(parseRetryAfterSeconds({ retryAfterSeconds: 42 }, '7')).toBe(42);
  });

  it('rounds a fractional body value up', () => {
    expect(parseRetryAfterSeconds({ retryAfterSeconds: 41.2 }, null)).toBe(42);
  });

  it('falls back to the Retry-After header when the body has no usable value', () => {
    expect(parseRetryAfterSeconds({ error: 'Rate limit exceeded' }, '120')).toBe(120);
    expect(parseRetryAfterSeconds({ retryAfterSeconds: 0 }, '30')).toBe(30);
    expect(parseRetryAfterSeconds({ retryAfterSeconds: 'soon' }, '30')).toBe(30);
    expect(parseRetryAfterSeconds(null, '15')).toBe(15);
  });

  it('falls back to the default when neither source is usable', () => {
    expect(parseRetryAfterSeconds(null, null)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds({}, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds({ retryAfterSeconds: -5 }, '-1')).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });
});

describe('readRateLimit', () => {
  it('returns null for a non-429 response, even with a retryAfterSeconds body', async () => {
    expect(await readRateLimit(res(200, { retryAfterSeconds: 9 }))).toBeNull();
    expect(await readRateLimit(res(500, { retryAfterSeconds: 9 }))).toBeNull();
    expect(await readRateLimit(res(401, {}))).toBeNull();
  });

  it('returns the body retryAfterSeconds for a 429', async () => {
    const r = res(429, { error: 'Rate limit exceeded', retryAfterSeconds: 321 }, { 'Retry-After': '5' });
    expect(await readRateLimit(r)).toEqual({ retryAfterSeconds: 321 });
  });

  it('uses the Retry-After header when the 429 body is not JSON', async () => {
    expect(await readRateLimit(res(429, 'slow down', { 'Retry-After': '77' }))).toEqual({ retryAfterSeconds: 77 });
  });

  it('leaves the original response body readable', async () => {
    const r = res(429, { retryAfterSeconds: 3 });
    await readRateLimit(r);
    expect(await r.json()).toEqual({ retryAfterSeconds: 3 });
  });
});

describe('scanAllStopMessage', () => {
  const template = 'stopped, retry in {seconds}s';

  it('stops with the retry time on a 429', async () => {
    expect(await scanAllStopMessage(res(429, { retryAfterSeconds: 321 }), template)).toBe('stopped, retry in 321s');
  });

  it('lets the loop continue on success and on other failures', async () => {
    expect(await scanAllStopMessage(res(200, {}), template)).toBeNull();
    expect(await scanAllStopMessage(res(500, { retryAfterSeconds: 9 }), template)).toBeNull();
    expect(await scanAllStopMessage(res(403, {}), template)).toBeNull();
  });
});

describe('rate-limit messages', () => {
  const keys = ['dashboard.scanAllRateLimited', 'ci.health.rateLimited'] as const;
  for (const locale of ['de', 'en'] as Locale[]) {
    for (const key of keys) {
      it(`${locale} ${key} carries the retry time`, () => {
        const msg = interpolate(getTranslations(locale)[key], { seconds: 123 });
        expect(msg).toContain('123');
        expect(msg).not.toContain('{seconds}');
      });
    }
  }
});
