// Unit tests for the in-process fixed-window rate limiter.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter, rateLimitedResponse } from '@/lib/rate-limit';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit and reports the remaining budget', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

    expect(limiter.check('u1')).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.check('u1')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('u1')).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('blocks the request after the limit with the seconds left in the window', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    limiter.check('u1');
    limiter.check('u1');
    vi.advanceTimersByTime(10_500);

    const result = limiter.check('u1');

    expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 50 });
  });

  it('keeps counting separate keys separately', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

    expect(limiter.check('u1').allowed).toBe(true);
    expect(limiter.check('u1').allowed).toBe(false);
    expect(limiter.check('u2').allowed).toBe(true);
  });

  it('starts a fresh window once the previous one has elapsed', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('u1');
    vi.advanceTimersByTime(59_999);
    expect(limiter.check('u1').allowed).toBe(false);

    vi.advanceTimersByTime(1);

    expect(limiter.check('u1')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check('u1').allowed).toBe(false);
  });

  it('never reports a Retry-After below one second', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('u1');
    vi.advanceTimersByTime(59_999);

    expect(limiter.check('u1').retryAfterSeconds).toBe(1);
  });

  it('reset forgets every window', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('u1');
    expect(limiter.check('u1').allowed).toBe(false);

    limiter.reset();

    expect(limiter.check('u1').allowed).toBe(true);
  });
});

describe('rateLimitedResponse', () => {
  it('is a 429 carrying the Retry-After header and body', async () => {
    const res = rateLimitedResponse({ allowed: false, remaining: 0, retryAfterSeconds: 42 });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: 42 });
  });
});
