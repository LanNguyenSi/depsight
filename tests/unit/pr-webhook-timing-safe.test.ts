// The signature comparison must go through crypto.timingSafeEqual, for every
// candidate secret and with no early exit on the first match. The wrapper
// below keeps the real behaviour and records the calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { timingSafeEqualSpy, repoFindManyMock } = vi.hoisted(() => ({
  timingSafeEqualSpy: vi.fn(),
  repoFindManyMock: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});
vi.mock('@/lib/pr/pr-scanner', () => ({ scanPRAndComment: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/prisma', () => ({ prisma: { repo: { findMany: repoFindManyMock } } }));

import { POST } from '@/app/api/webhooks/github/route';
import { verifyGitHubSignature, prWebhookDeliveries } from '@/lib/pr/webhook-security';
import { sealWebhookSecret } from '@/lib/pr/webhook-secret';
import { prScanWebhookRepoRateLimiter, prScanWebhookTotalRateLimiter } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';

const BODY = JSON.stringify({
  action: 'opened',
  number: 7,
  repository: { name: 'api', owner: { login: 'acme' } },
  pull_request: { head: { repo: { full_name: 'acme/api' } } },
});

function sign(secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(BODY).digest('hex');
}

function candidate(id: string, secret: string) {
  return {
    id,
    userId: `user-${id}`,
    owner: 'acme',
    name: 'api',
    webhookSecretEnc: sealWebhookSecret(secret, id),
    user: { githubToken: `tok-${id}` },
  };
}

describe('timing-safe signature comparison', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
    timingSafeEqualSpy.mockClear();
    prWebhookDeliveries.reset();
    prScanWebhookRepoRateLimiter.reset();
    prScanWebhookTotalRateLimiter.reset();
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
  });

  it('compares the digests with timingSafeEqual on two 32-byte buffers', () => {
    expect(verifyGitHubSignature(Buffer.from(BODY), sign('s'), 's')).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [a, b] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it('does not reach the comparison for a malformed header', () => {
    expect(verifyGitHubSignature(Buffer.from(BODY), 'sha256=abcd', 's')).toBe(false);
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('compares against every candidate row, matching or not, with no early exit', async () => {
    repoFindManyMock.mockResolvedValue([
      candidate('r1', 'secret-one'),
      candidate('r2', 'secret-two'),
      candidate('r3', 'secret-three'),
    ]);

    // Signed with the FIRST candidate's secret: a short-circuit would stop at one comparison.
    const res = await POST(
      new NextRequest('http://localhost/api/webhooks/github', {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'dddddddd-0000-0000-0000-000000000001',
          'x-hub-signature-256': sign('secret-one'),
        },
        body: BODY,
      }),
    );

    expect(res.status).toBe(202);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(3);
  });
});
