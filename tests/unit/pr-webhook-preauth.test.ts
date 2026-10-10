// Pre-verification limits and the opt-out of POST /api/webhooks/github.
// They run before the body is read, so these tests check that a 429 or 404
// leaves the body unread and unparsed, which address the limiter keys on, and
// that the existing post-verification path is unchanged when under the limit.
// The scanner and prisma are mocked; the limiters run for real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { scanPRAndCommentMock, repoFindManyMock } = vi.hoisted(() => ({
  scanPRAndCommentMock: vi.fn(),
  repoFindManyMock: vi.fn(),
}));

vi.mock('@/lib/pr/pr-scanner', () => ({ scanPRAndComment: scanPRAndCommentMock }));
vi.mock('@/lib/prisma', () => ({ prisma: { repo: { findMany: repoFindManyMock } } }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/webhooks/github/route';
import { prWebhookDeliveries } from '@/lib/pr/webhook-security';
import { sealWebhookSecret } from '@/lib/pr/webhook-secret';
import {
  prScanWebhookPreAuthIpRateLimiter,
  prScanWebhookPreAuthTotalRateLimiter,
  prScanWebhookRepoRateLimiter,
  prScanWebhookTotalRateLimiter,
  prScanWebhookUserRateLimiter,
  PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE,
  PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE,
} from '@/lib/rate-limit';

const SECRET = 'preauth-test-secret';
const IP_LIMIT = PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE;
const GOOD_IP = '203.0.113.9';

let deliveryCounter = 0;

const BODY = JSON.stringify({
  action: 'opened',
  number: 7,
  repository: { name: 'api', owner: { login: 'acme' } },
  pull_request: { head: { repo: { full_name: 'acme/api' } } },
});

function request(opts: { forwardedFor?: string | null; signed?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-github-delivery': `d0000000-0000-0000-0000-${String(++deliveryCounter).padStart(12, '0')}`,
  };
  if (opts.signed !== false) {
    headers['x-hub-signature-256'] =
      'sha256=' + createHmac('sha256', SECRET).update(BODY).digest('hex');
  }
  if (opts.forwardedFor !== null && opts.forwardedFor !== undefined) {
    headers['x-forwarded-for'] = opts.forwardedFor;
  }
  return new NextRequest('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers,
    body: BODY,
  });
}

/** Spend the whole per-address budget of one key without going through the route. */
function exhaustIp(key: string): void {
  for (let i = 0; i < IP_LIMIT; i++) prScanWebhookPreAuthIpRateLimiter.check(key);
}

describe('POST /api/webhooks/github pre-verification limits', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
    delete process.env.WEBHOOK_SECRET_KEY;
    delete process.env.WEBHOOK_TRUSTED_PROXY_HOPS;
    delete process.env.GITHUB_WEBHOOK_DISABLED;
    scanPRAndCommentMock.mockReset();
    scanPRAndCommentMock.mockResolvedValue({ commented: true, newCVECount: 0, commentUrl: null });
    repoFindManyMock.mockReset();
    repoFindManyMock.mockResolvedValue([
      {
        id: 'repo-row-1',
        userId: 'user-1',
        owner: 'acme',
        name: 'api',
        webhookSecretEnc: sealWebhookSecret(SECRET, 'repo-row-1'),
        user: { githubToken: 'tok-123' },
      },
    ]);
    prWebhookDeliveries.reset();
    prScanWebhookRepoRateLimiter.reset();
    prScanWebhookUserRateLimiter.reset();
    prScanWebhookTotalRateLimiter.reset();
    prScanWebhookPreAuthIpRateLimiter.reset();
    prScanWebhookPreAuthTotalRateLimiter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.WEBHOOK_TRUSTED_PROXY_HOPS;
    delete process.env.GITHUB_WEBHOOK_DISABLED;
    vi.restoreAllMocks();
  });

  describe('before the body is read', () => {
    it('reads and verifies the body of a request under the limit (control)', async () => {
      const req = request({ forwardedFor: GOOD_IP });
      const res = await POST(req);
      expect(res.status).toBe(202);
      expect(req.bodyUsed).toBe(true);
      expect(repoFindManyMock).toHaveBeenCalledTimes(1);
    });

    it('answers 429 over the per-address limit without reading, parsing or looking anything up', async () => {
      exhaustIp(GOOD_IP);
      const parse = vi.spyOn(JSON, 'parse');
      const req = request({ forwardedFor: GOOD_IP });

      const res = await POST(req);

      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(req.bodyUsed).toBe(false);
      expect(parse).not.toHaveBeenCalled();
      expect(repoFindManyMock).not.toHaveBeenCalled();
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    });

    it('answers 429 over the endpoint-wide ceiling for an address with budget left, body unread', async () => {
      for (let i = 0; i < PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE; i++) {
        prScanWebhookPreAuthTotalRateLimiter.check('all');
      }
      const parse = vi.spyOn(JSON, 'parse');
      const req = request({ forwardedFor: '198.51.100.1' });

      const res = await POST(req);

      expect(res.status).toBe(429);
      expect(req.bodyUsed).toBe(false);
      expect(parse).not.toHaveBeenCalled();
      expect(repoFindManyMock).not.toHaveBeenCalled();
    });

    it('warns once per window when the endpoint-wide ceiling refuses requests, and again in the next window', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const warnings = () =>
          vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('endpoint-wide'));
        const exhaustTotal = () => {
          for (let i = 0; i < PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE; i++) {
            prScanWebhookPreAuthTotalRateLimiter.check('all');
          }
        };
        // Far enough ahead that a warning from an earlier test cannot mask this one.
        vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
        exhaustTotal();

        for (let i = 0; i < 3; i++) {
          expect((await POST(request({ forwardedFor: `198.51.100.${i + 1}` }))).status).toBe(429);
        }
        expect(warnings()).toHaveLength(1);

        vi.setSystemTime(Date.now() + 61 * 1000);
        prScanWebhookPreAuthIpRateLimiter.reset();
        exhaustTotal();
        expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
        expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
        expect(warnings()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not warn about the ceiling for a request refused for its own address', async () => {
      exhaustIp(GOOD_IP);
      await POST(request({ forwardedFor: GOOD_IP }));
      expect(
        vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('endpoint-wide')),
      ).toHaveLength(0);
    });

    it('counts unsigned and badly signed requests too, so they cannot be used to dodge the limit', async () => {
      for (let i = 0; i < IP_LIMIT; i++) {
        const res = await POST(request({ forwardedFor: GOOD_IP, signed: false }));
        expect(res.status).toBe(401);
      }
      const res = await POST(request({ forwardedFor: GOOD_IP, signed: false }));
      expect(res.status).toBe(429);
    });

    it('does not spend the endpoint-wide ceiling on a request already refused for its address', async () => {
      exhaustIp(GOOD_IP);
      await POST(request({ forwardedFor: GOOD_IP }));
      expect(prScanWebhookPreAuthTotalRateLimiter.check('all').remaining).toBe(
        PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE - 1,
      );
    });

    it('keeps the 503 for a missing sealing key ahead of the limiter', async () => {
      delete process.env.NEXTAUTH_SECRET;
      const res = await POST(request({ forwardedFor: GOOD_IP }));
      expect(res.status).toBe(503);
      expect(prScanWebhookPreAuthIpRateLimiter.check(GOOD_IP).remaining).toBe(IP_LIMIT - 1);
    });
  });

  describe('per-address isolation', () => {
    it('limits one address without touching another', async () => {
      exhaustIp(GOOD_IP);

      expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
      expect((await POST(request({ forwardedFor: '198.51.100.77' }))).status).toBe(202);
    });
  });

  describe('trusted proxy header', () => {
    it('keys on the last entry (the hop traefik appended) by default, not the client-written ones', async () => {
      exhaustIp(GOOD_IP);

      const res = await POST(request({ forwardedFor: `6.6.6.6, ${GOOD_IP}` }));

      expect(res.status).toBe(429);
    });

    it('cannot mint buckets by varying the leftmost entry while the trusted hop stays the same', async () => {
      for (let i = 0; i < IP_LIMIT; i++) {
        const res = await POST(request({ forwardedFor: `10.0.0.${i}, ${GOOD_IP}`, signed: false }));
        expect(res.status).toBe(401);
      }
      const res = await POST(request({ forwardedFor: `10.0.1.1, ${GOOD_IP}`, signed: false }));
      expect(res.status).toBe(429);
    });

    it('puts a request without the header into one shared unknown bucket', async () => {
      for (let i = 0; i < IP_LIMIT; i++) {
        expect((await POST(request({ signed: false }))).status).toBe(401);
      }
      expect((await POST(request({ signed: false }))).status).toBe(429);
      // A request that does name an address is not in that bucket.
      expect((await POST(request({ forwardedFor: GOOD_IP, signed: false }))).status).toBe(401);
    });

    it('treats a header that is not an address as unknown rather than keying on arbitrary text', async () => {
      for (let i = 0; i < IP_LIMIT; i++) {
        expect((await POST(request({ forwardedFor: `junk-${i}`, signed: false }))).status).toBe(
          401,
        );
      }
      expect((await POST(request({ forwardedFor: 'junk-x', signed: false }))).status).toBe(429);
      expect((await POST(request({ signed: false }))).status).toBe(429);
    });

    it('counts hops from the right: with two trusted proxies the second entry from the right is the client', async () => {
      process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '2';
      exhaustIp(GOOD_IP);

      const res = await POST(request({ forwardedFor: `6.6.6.6, ${GOOD_IP}, 10.1.1.1` }));
      expect(res.status).toBe(429);

      // Fewer entries than trusted proxies: the chain is not the expected one, so unknown.
      const short = await POST(request({ forwardedFor: GOOD_IP }));
      expect(short.status).toBe(202);
      expect(prScanWebhookPreAuthIpRateLimiter.check('unknown').remaining).toBe(IP_LIMIT - 2);
    });

    it('ignores the header entirely when no proxy is trusted (hops 0)', async () => {
      process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '0';
      exhaustIp(GOOD_IP);

      // The exhausted address is not consulted, a fresh one is not either.
      expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(202);
      for (let i = 0; i < IP_LIMIT - 1; i++) {
        await POST(request({ forwardedFor: `192.0.2.${i}`, signed: false }));
      }
      expect((await POST(request({ forwardedFor: '192.0.2.250', signed: false }))).status).toBe(
        429,
      );
    });

    it('falls back to one trusted hop, with one warning, for an unusable WEBHOOK_TRUSTED_PROXY_HOPS', async () => {
      process.env.WEBHOOK_TRUSTED_PROXY_HOPS = 'lots';
      exhaustIp(GOOD_IP);

      expect((await POST(request({ forwardedFor: `6.6.6.6, ${GOOD_IP}` }))).status).toBe(429);
      await POST(request({ forwardedFor: GOOD_IP }));
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('WEBHOOK_TRUSTED_PROXY_HOPS');
    });
  });

  describe('opt-out', () => {
    it('answers 404 with the body unread when GITHUB_WEBHOOK_DISABLED is true', async () => {
      process.env.GITHUB_WEBHOOK_DISABLED = ' TRUE ';
      const parse = vi.spyOn(JSON, 'parse');
      const req = request({ forwardedFor: GOOD_IP });

      const res = await POST(req);

      expect(res.status).toBe(404);
      expect(req.bodyUsed).toBe(false);
      expect(parse).not.toHaveBeenCalled();
      expect(repoFindManyMock).not.toHaveBeenCalled();
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
      // A switched-off endpoint spends no limiter budget.
      expect(prScanWebhookPreAuthIpRateLimiter.check(GOOD_IP).remaining).toBe(IP_LIMIT - 1);
    });

    it('stays on for any other value', async () => {
      process.env.GITHUB_WEBHOOK_DISABLED = 'false';
      expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(202);
    });
  });
});
