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
import { githubHookRanges } from '@/lib/github-hook-ranges';
import { prWebhookDeliveries } from '@/lib/pr/webhook-security';
import { sealWebhookSecret } from '@/lib/pr/webhook-secret';
import {
  prScanWebhookPreAuthIpRateLimiter,
  prScanWebhookPreAuthTotalRateLimiter,
  prScanWebhookPreAuthHookIpRateLimiter,
  prScanWebhookPreAuthHookRateLimiter,
  prScanWebhookRepoRateLimiter,
  prScanWebhookTotalRateLimiter,
  prScanWebhookUserRateLimiter,
  PR_SCAN_WEBHOOK_PREAUTH_HOOK_LIMIT_PER_MINUTE,
  PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE,
  PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS,
  PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE,
} from '@/lib/rate-limit';

const SECRET = 'preauth-test-secret';
const IP_LIMIT = PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE;
const GOOD_IP = '203.0.113.9';
const HOOK_LIMIT = PR_SCAN_WEBHOOK_PREAUTH_HOOK_LIMIT_PER_MINUTE;
const TOTAL_LIMIT = PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE;
// Addresses inside the ranges used by the hook-range tests below.
const GH_V4 = '140.82.112.5';
const GH_V6 = '2a0a:a440::7';

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
    prScanWebhookPreAuthHookRateLimiter.reset();
    prScanWebhookPreAuthHookIpRateLimiter.reset();
    // The route may start a background fetch of GitHub's hook ranges; keep it off the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ hooks: ['2001:db8::/32'] }))),
    );
    githubHookRanges.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.WEBHOOK_TRUSTED_PROXY_HOPS;
    delete process.env.GITHUB_WEBHOOK_DISABLED;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    it('warns for the first ceiling refusal of the next window even right after the window turns', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const warnings = () =>
          vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('endpoint-wide'));
        const exhaustTotal = () => {
          for (let i = 0; i < PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE; i++) {
            prScanWebhookPreAuthTotalRateLimiter.check('all');
          }
        };
        const windowStart = Date.now() + 4 * 60 * 60 * 1000;
        vi.setSystemTime(windowStart);
        exhaustTotal();
        vi.setSystemTime(windowStart + 59_900);
        expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
        expect(warnings()).toHaveLength(1);

        // 50 ms into the next window: a rounded-up retry time would still cover this.
        vi.setSystemTime(windowStart + 60_050);
        prScanWebhookPreAuthIpRateLimiter.reset();
        exhaustTotal();
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
  describe("GitHub's hook address ranges", () => {
    /** Make the route see these hook ranges (no network: the global fetch is a mock). */
    async function loadHookRanges(hooks: string[] = ['140.82.112.0/20', '2a0a:a440::/29']) {
      vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ hooks })));
      await githubHookRanges.refresh();
    }

    function exhaustTotal(): void {
      for (let i = 0; i < TOTAL_LIMIT; i++) prScanWebhookPreAuthTotalRateLimiter.check('all');
    }

    function exhaustHook(): void {
      for (let i = 0; i < HOOK_LIMIT; i++) prScanWebhookPreAuthHookRateLimiter.check('all');
    }

    it('counts a request from a hook address against the hook budget only', async () => {
      await loadHookRanges();

      for (let i = 0; i < 5; i++) {
        expect((await POST(request({ forwardedFor: `140.82.112.${i + 1}`, signed: false }))).status).toBe(401);
      }

      expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 6);
      expect(prScanWebhookPreAuthTotalRateLimiter.check('all').remaining).toBe(TOTAL_LIMIT - 1);
    });

    it('counts a request from any other address against the endpoint-wide ceiling only', async () => {
      await loadHookRanges();

      expect((await POST(request({ forwardedFor: GOOD_IP, signed: false }))).status).toBe(401);

      expect(prScanWebhookPreAuthTotalRateLimiter.check('all').remaining).toBe(TOTAL_LIMIT - 2);
      expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
    });

    it('still accepts a hook address after non-GitHub traffic has spent the whole ceiling', async () => {
      await loadHookRanges();
      exhaustTotal();

      // Non-GitHub callers are refused ...
      expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
      // ... and GitHub's deliveries, over IPv4 and IPv6, still get through (the second
      // carries the same body as the first, so the replay guard answers 200 for it).
      expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(202);
      expect((await POST(request({ forwardedFor: GH_V6 }))).status).toBe(200);
    });

    it('spends the ceiling through the route itself, not only through the limiter', async () => {
      await loadHookRanges();
      // Ten source addresses at 60 a minute each: the honest exhaustion the budget exists for.
      for (let a = 0; a < TOTAL_LIMIT / IP_LIMIT; a++) {
        for (let i = 0; i < IP_LIMIT; i++) {
          expect((await POST(request({ forwardedFor: `198.51.100.${a + 1}`, signed: false }))).status).toBe(401);
        }
      }
      expect((await POST(request({ forwardedFor: '198.51.100.99', signed: false }))).status).toBe(429);

      expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(202);
    });

    it('refuses hook addresses over their own budget without touching the ceiling, and non-GitHub callers stay unaffected', async () => {
      await loadHookRanges();
      exhaustHook();

      const req = request({ forwardedFor: GH_V4 });
      const res = await POST(req);

      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(req.bodyUsed).toBe(false);
      expect(prScanWebhookPreAuthTotalRateLimiter.check('all').remaining).toBe(TOTAL_LIMIT - 1);
      expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(202);
    });

    it('warns once per window when the hook budget refuses requests, and again in the next window', async () => {
      await loadHookRanges();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const warnings = () =>
          vi
            .mocked(console.warn)
            .mock.calls.filter((c) => String(c[0]).includes("GitHub's hook addresses"));
        // Far ahead of any window an earlier test opened, so its warning cannot mask this one.
        vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
        exhaustHook();

        for (let i = 1; i <= 3; i++) {
          expect((await POST(request({ forwardedFor: `140.82.112.${i}` }))).status).toBe(429);
        }
        expect(warnings()).toHaveLength(1);
        expect(String(warnings()[0][0])).not.toContain('endpoint-wide');

        vi.setSystemTime(Date.now() + 61 * 1000);
        prScanWebhookPreAuthIpRateLimiter.reset();
        exhaustHook();
        expect((await POST(request({ forwardedFor: '140.82.112.9' }))).status).toBe(429);
        expect(warnings()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still limits one hook address by its own per-address window', async () => {
      await loadHookRanges();
      for (let i = 0; i < IP_LIMIT; i++) prScanWebhookPreAuthHookIpRateLimiter.check(GH_V4);

      expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(429);
      // The refusal for the address spends neither shared budget.
      expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
      expect((await POST(request({ forwardedFor: '140.82.112.6' }))).status).toBe(202);
    });

    it('keeps the per-address windows of hook addresses apart from those of other addresses', async () => {
      await loadHookRanges();

      // Spending the general per-address window of an address does not touch the hook one.
      exhaustIp(GH_V4);
      expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(202);
      expect(prScanWebhookPreAuthHookIpRateLimiter.check(GH_V4).remaining).toBe(IP_LIMIT - 2);
    });

    describe('when non-GitHub traffic fills the general per-address table', () => {
      /** Live windows past the cap, then the shared overflow bucket spent, all from non-GitHub keys. */
      function fillGeneralTable(): void {
        for (let i = 0; i < PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS; i++) {
          prScanWebhookPreAuthIpRateLimiter.check(`filler-${i}`);
        }
        for (let i = 0; i < IP_LIMIT; i++) prScanWebhookPreAuthIpRateLimiter.check(`overflow-${i}`);
      }

      it('still accepts a hook-range delivery, while a new non-GitHub address is refused', async () => {
        await loadHookRanges();
        fillGeneralTable();

        // Control: an address outside the ranges meets the shared overflow bucket and is refused.
        expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
        // A hook-range delivery has a table of its own.
        expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(202);
        expect((await POST(request({ forwardedFor: GH_V6 }))).status).toBe(200);
      });

      it('refuses the same delivery when its address is not classified as a hook address (control)', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('meta unreachable'));
        await githubHookRanges.refresh();
        fillGeneralTable();

        expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(429);
      });
    });

    it('classifies by the trusted address, not by an entry the caller wrote to the left', async () => {
      await loadHookRanges();
      exhaustTotal();

      // A hook address in the leftmost (caller-written) entry, a non-GitHub trusted hop:
      // counted as non-GitHub, so it meets the exhausted ceiling and spends no hook budget.
      const spoof = await POST(request({ forwardedFor: `${GH_V4}, ${GOOD_IP}` }));
      expect(spoof.status).toBe(429);
      expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);

      // The reverse is a genuine delivery: trusted hop in the ranges, junk to its left.
      const genuine = await POST(request({ forwardedFor: `${GOOD_IP}, ${GH_V4}` }));
      expect(genuine.status).toBe(202);
    });

    it('classifies by the trusted hop when two proxies are trusted', async () => {
      process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '2';
      await loadHookRanges();
      exhaustTotal();

      // The client is the second entry from the right.
      expect((await POST(request({ forwardedFor: `${GOOD_IP}, ${GH_V4}, 10.1.1.1` }))).status).toBe(202);
      expect((await POST(request({ forwardedFor: `${GH_V4}, ${GOOD_IP}, 10.1.1.1` }))).status).toBe(429);
      // Too short a chain: unknown, never a hook address.
      expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(429);
    });

    describe('when no proxy hop is trusted (WEBHOOK_TRUSTED_PROXY_HOPS=0)', () => {
      it('does not classify a hook address written to X-Forwarded-For, fetches nothing, and counts it against the ceiling', async () => {
        process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '0';

        // Ranges not loaded yet: a classification attempt would start the fetch.
        expect((await POST(request({ forwardedFor: GH_V4, signed: false }))).status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
        expect(prScanWebhookPreAuthTotalRateLimiter.check('all').remaining).toBe(TOTAL_LIMIT - 2);
        expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
      });

      it('shares one unknown address and the ceiling even when the ranges are known', async () => {
        await loadHookRanges();
        vi.mocked(fetch).mockClear();
        process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '0';
        exhaustTotal();

        expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(429);
        expect((await POST(request({ forwardedFor: `${GOOD_IP}, ${GH_V4}` }))).status).toBe(429);
        expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
        expect(prScanWebhookPreAuthHookIpRateLimiter.check(GH_V4).remaining).toBe(IP_LIMIT - 1);
        expect(prScanWebhookPreAuthIpRateLimiter.check('unknown').remaining).toBe(IP_LIMIT - 3);
        expect(fetch).not.toHaveBeenCalled();
      });
    });

    it('treats a request without a trusted address as non-GitHub', async () => {
      await loadHookRanges();
      exhaustTotal();

      expect((await POST(request({}))).status).toBe(429);
      expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
    });

    it('matches an IPv4-mapped IPv6 trusted address against the IPv4 ranges', async () => {
      await loadHookRanges();
      exhaustTotal();

      expect((await POST(request({ forwardedFor: '::ffff:140.82.112.5' }))).status).toBe(202);
      expect((await POST(request({ forwardedFor: '::ffff:140.82.128.0' }))).status).toBe(429);
    });

    it('uses the first and last address of a range and nothing beyond it', async () => {
      await loadHookRanges(['140.82.112.0/20']);
      exhaustTotal();

      // Unsigned, so the replay guard is not reached: 401 means the limiter let it through.
      expect((await POST(request({ forwardedFor: '140.82.112.0', signed: false }))).status).toBe(401);
      expect((await POST(request({ forwardedFor: '140.82.127.255', signed: false }))).status).toBe(401);
      expect((await POST(request({ forwardedFor: '140.82.111.255' }))).status).toBe(429);
      expect((await POST(request({ forwardedFor: '140.82.128.0' }))).status).toBe(429);
    });

    describe('when the ranges are not known', () => {
      it('keeps the single ceiling for everyone after a failed fetch', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('meta unreachable'));
        await githubHookRanges.refresh();
        exhaustTotal();

        expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(429);
        expect((await POST(request({ forwardedFor: GOOD_IP }))).status).toBe(429);
        expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('hook address ranges'));
      });

      it('counts a hook address against the ceiling after a failed fetch, as it did before the budget existed', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response('bad gateway', { status: 502 }));
        await githubHookRanges.refresh();

        expect((await POST(request({ forwardedFor: GH_V4, signed: false }))).status).toBe(401);

        expect(prScanWebhookPreAuthTotalRateLimiter.check('all').remaining).toBe(TOTAL_LIMIT - 2);
        expect(prScanWebhookPreAuthHookRateLimiter.check('all').remaining).toBe(HOOK_LIMIT - 1);
      });

      it('answers the first request from the ceiling and fetches the ranges in the background, once', async () => {
        let release: (res: Response) => void = () => undefined;
        vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
        exhaustTotal();

        // No ranges yet: the request is classified without them (and not blocked on the fetch).
        expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(429);
        expect((await POST(request({ forwardedFor: '140.82.112.6' }))).status).toBe(429);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.github.com/meta');

        release(new Response(JSON.stringify({ hooks: ['140.82.112.0/20'] })));
        await githubHookRanges.refresh();
        expect((await POST(request({ forwardedFor: GH_V4 }))).status).toBe(202);
      });
    });
  });
});
