// Unit tests for the in-process fixed-window rate limiter.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRateLimiter,
  rateLimitedResponse,
  prScanWebhookPreAuthIpRateLimiter,
  PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE,
  PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS,
  policyCreateRateLimiter,
  webhookCreateRateLimiter,
  slackConfigRateLimiter,
  apiTokenCreateRateLimiter,
  policyEvaluateRateLimiter,
  POLICY_CREATE_LIMIT_PER_HOUR,
  WEBHOOK_CREATE_LIMIT_PER_HOUR,
  SLACK_CONFIG_LIMIT_PER_HOUR,
  API_TOKEN_CREATE_LIMIT_PER_HOUR,
  POLICY_EVALUATE_LIMIT_PER_HOUR,
  MAX_POLICIES_PER_USER,
  MAX_WEBHOOKS_PER_USER,
  MAX_API_TOKENS_PER_USER,
} from '@/lib/rate-limit';

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
    const start = Date.now();
    limiter.check('u1');
    limiter.check('u1');
    vi.advanceTimersByTime(10_500);

    const result = limiter.check('u1');

    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 50,
      resetAt: start + 60_000,
    });
  });

  it('reports the window end on an allowed call later in the same window', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const start = Date.now();
    limiter.check('u1');
    vi.advanceTimersByTime(5_000);

    expect(limiter.check('u1')).toMatchObject({ allowed: true, resetAt: start + 60_000 });
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
    const res = rateLimitedResponse({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: 0,
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toStrictEqual({ error: 'Rate limit exceeded', retryAfterSeconds: 42 });
  });
});

describe('createRateLimiter maxKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts keys beyond the cap in one shared overflow bucket and keeps existing keys apart', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    // Table full: c and d are not given entries of their own.
    expect(limiter.check('c').allowed).toBe(true);
    expect(limiter.check('d').allowed).toBe(false);
    // The keys that got in still count on their own.
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('frees lapsed windows when full so a new key gets its own bucket again', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');

    vi.advanceTimersByTime(61_000);

    expect(limiter.check('c').allowed).toBe(true);
    expect(limiter.check('c').allowed).toBe(false);
    expect(limiter.check('d').allowed).toBe(true);
  });
});

describe('prScanWebhookPreAuthIpRateLimiter table cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    prScanWebhookPreAuthIpRateLimiter.reset();
  });

  afterEach(() => {
    prScanWebhookPreAuthIpRateLimiter.reset();
    vi.useRealTimers();
  });

  it('stops giving new addresses their own window once the table is full', () => {
    for (let i = 0; i < PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS; i++) {
      expect(prScanWebhookPreAuthIpRateLimiter.check(`addr-${i}`).allowed).toBe(true);
    }
    // New addresses past the cap share one overflow bucket: the per-address
    // budget runs out across them, where uncapped each would start afresh.
    for (let i = 0; i < PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE; i++) {
      expect(prScanWebhookPreAuthIpRateLimiter.check(`overflow-${i}`).allowed).toBe(true);
    }
    expect(prScanWebhookPreAuthIpRateLimiter.check('overflow-next').allowed).toBe(false);
    // An address that already had a window keeps counting on its own.
    expect(prScanWebhookPreAuthIpRateLimiter.check('addr-0').allowed).toBe(true);
  });
});

const HOUR_WINDOW_LIMITERS: Array<[string, ReturnType<typeof createRateLimiter>, number]> = [
  ['policyCreateRateLimiter', policyCreateRateLimiter, POLICY_CREATE_LIMIT_PER_HOUR],
  ['webhookCreateRateLimiter', webhookCreateRateLimiter, WEBHOOK_CREATE_LIMIT_PER_HOUR],
  ['slackConfigRateLimiter', slackConfigRateLimiter, SLACK_CONFIG_LIMIT_PER_HOUR],
  ['apiTokenCreateRateLimiter', apiTokenCreateRateLimiter, API_TOKEN_CREATE_LIMIT_PER_HOUR],
  ['policyEvaluateRateLimiter', policyEvaluateRateLimiter, POLICY_EVALUATE_LIMIT_PER_HOUR],
];

describe('config-write and evaluate limiters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (const [, limiter] of HOUR_WINDOW_LIMITERS) limiter.reset();
  });

  afterEach(() => {
    for (const [, limiter] of HOUR_WINDOW_LIMITERS) limiter.reset();
    vi.useRealTimers();
  });

  it('pins the frozen budgets: 60 / 60 / 60 per hour writes, 30 token mints, 300 evaluations', () => {
    expect(POLICY_CREATE_LIMIT_PER_HOUR).toBe(60);
    expect(WEBHOOK_CREATE_LIMIT_PER_HOUR).toBe(60);
    expect(SLACK_CONFIG_LIMIT_PER_HOUR).toBe(60);
    expect(API_TOKEN_CREATE_LIMIT_PER_HOUR).toBe(30);
    expect(POLICY_EVALUATE_LIMIT_PER_HOUR).toBe(300);
  });

  it.each(HOUR_WINDOW_LIMITERS)(
    '%s spends its whole budget inside the hour and blocks one request later with a one-hour Retry-After',
    (_name, limiter, limit) => {
      for (let i = 0; i < limit; i++) {
        expect(limiter.check('u1').allowed).toBe(true);
      }
      const blocked = limiter.check('u1');
      expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 3600 });
      // A different user is untouched, and the window resets after the hour.
      expect(limiter.check('u2').allowed).toBe(true);
      vi.advanceTimersByTime(3_600_000);
      expect(limiter.check('u1').allowed).toBe(true);
    },
  );

  it('gives each limiter a budget of its own', () => {
    for (let i = 0; i < API_TOKEN_CREATE_LIMIT_PER_HOUR; i++) {
      expect(apiTokenCreateRateLimiter.check('u1').allowed).toBe(true);
    }
    expect(apiTokenCreateRateLimiter.check('u1').allowed).toBe(false);
    // The token budget does not touch the others.
    expect(policyCreateRateLimiter.check('u1').allowed).toBe(true);
    expect(policyEvaluateRateLimiter.check('u1').allowed).toBe(true);
  });
});

describe('per-user storage caps', () => {
  it('pins the frozen caps: 100 policies, 20 webhooks, 50 active tokens', () => {
    expect(MAX_POLICIES_PER_USER).toBe(100);
    expect(MAX_WEBHOOKS_PER_USER).toBe(20);
    expect(MAX_API_TOKENS_PER_USER).toBe(50);
  });
});
