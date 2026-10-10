// Route-level tests for POST /api/webhooks/github (inbound GitHub webhook).
// No session: the HMAC is the only authentication. The scanner and prisma are
// mocked; signature, rate limiter and replay guard run for real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { scanPRAndCommentMock, repoFindFirstMock } = vi.hoisted(() => ({
  scanPRAndCommentMock: vi.fn(),
  repoFindFirstMock: vi.fn(),
}));

vi.mock('@/lib/pr/pr-scanner', () => ({ scanPRAndComment: scanPRAndCommentMock }));
vi.mock('@/lib/prisma', () => ({ prisma: { repo: { findFirst: repoFindFirstMock } } }));

import { POST } from '@/app/api/webhooks/github/route';
import { MAX_BODY_BYTES, prWebhookDeliveries } from '@/lib/pr/webhook-security';
import {
  prScanWebhookRepoRateLimiter,
  prScanWebhookTotalRateLimiter,
  PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR,
} from '@/lib/rate-limit';
import { NextRequest } from 'next/server';

const SECRET = 'test-webhook-secret';
const TRACKED = { userId: 'user-1', user: { githubToken: 'tok-123' } };

let deliveryCounter = 0;

interface Opts {
  event?: string | null;
  delivery?: string | null;
  signature?: string | null;
  secret?: string;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    number: 42,
    repository: { name: 'api', owner: { login: 'acme' } },
    // Present in real payloads and must never be fetched or trusted.
    pull_request: { url: 'http://169.254.169.254/latest/meta-data' },
    ...over,
  };
}

function makeRequest(rawBody: string, opts: Opts = {}): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const event = opts.event === undefined ? 'pull_request' : opts.event;
  if (event !== null) headers['x-github-event'] = event;
  const delivery =
    opts.delivery === undefined
      ? `d0000000-0000-0000-0000-${String(++deliveryCounter).padStart(12, '0')}`
      : opts.delivery;
  if (delivery !== null) headers['x-github-delivery'] = delivery;
  const signature =
    opts.signature === undefined
      ? 'sha256=' +
        createHmac('sha256', opts.secret ?? SECRET)
          .update(rawBody)
          .digest('hex')
      : opts.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return new NextRequest('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function signed(body: Record<string, unknown> = payload(), opts: Opts = {}): NextRequest {
  return makeRequest(JSON.stringify(body), opts);
}

describe('POST /api/webhooks/github', () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    scanPRAndCommentMock.mockReset();
    scanPRAndCommentMock.mockResolvedValue({ commented: true, newCVECount: 0, commentUrl: null });
    repoFindFirstMock.mockReset();
    repoFindFirstMock.mockResolvedValue(TRACKED);
    prWebhookDeliveries.reset();
    prScanWebhookRepoRateLimiter.reset();
    prScanWebhookTotalRateLimiter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.restoreAllMocks();
  });

  it('runs the PR scan with the tracking user token for a signed opened event', async () => {
    const res = await POST(signed());

    expect(res.status).toBe(202);
    expect(repoFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ owner: 'acme', name: 'api', tracked: true }),
      }),
    );
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
    expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-123', 'acme', 'api', 42, 'user-1');
  });

  it('looks the repository up among tracked rows of users with a stored token, oldest first', async () => {
    await POST(signed());

    expect(repoFindFirstMock).toHaveBeenCalledTimes(1);
    const args = repoFindFirstMock.mock.calls[0][0];
    expect(args.where).toEqual({
      owner: 'acme',
      name: 'api',
      tracked: true,
      user: { githubToken: { not: '' } },
    });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('also scans a synchronize event', async () => {
    const res = await POST(signed(payload({ action: 'synchronize' })));
    expect(res.status).toBe(202);
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
  });

  it('is disabled with 503 and never scans when the secret is unset', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const res = await POST(signed());
    expect(res.status).toBe(503);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindFirstMock).not.toHaveBeenCalled();
  });

  it('is disabled when the secret is blank, even for a request signed with the blank secret', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = '   ';
    const res = await POST(signed(payload(), { secret: '   ' }));
    expect(res.status).toBe(503);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a scan for a missing signature', async () => {
    const res = await POST(signed(payload(), { signature: null }));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindFirstMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a scan for a signature made with another secret', async () => {
    const res = await POST(signed(payload(), { secret: 'wrong' }));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers 401 for a signature over a different body', async () => {
    const other = 'sha256=' + createHmac('sha256', SECRET).update('{}').digest('hex');
    const res = await POST(signed(payload(), { signature: other }));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it.each(['sha256=abcd', 'sha256=' + 'a'.repeat(66), 'sha256=', 'sha1=' + 'a'.repeat(40)])(
    'answers 401 and does not throw for a length-mismatched signature %#',
    async (signature) => {
      const res = await POST(signed(payload(), { signature }));
      expect(res.status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    },
  );

  it('verifies the raw bytes, not a re-serialised body', async () => {
    const raw =
      '{"action": "opened",  "number": 42, "repository": {"name":"api","owner":{"login":"acme"}}}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    const signature = 'sha256=' + createHmac('sha256', SECRET).update(reserialised).digest('hex');
    const res = await POST(makeRequest(raw, { signature }));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('ignores a replayed delivery id', async () => {
    const delivery = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    const first = await POST(signed(payload(), { delivery }));
    const second = await POST(signed(payload({ number: 43 }), { delivery }));

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, ignored: 'duplicate delivery' });
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a replayed body that carries a fresh delivery id', async () => {
    const first = await POST(signed());
    const second = await POST(signed());

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
  });

  it('lets a failed scan be redelivered', async () => {
    scanPRAndCommentMock.mockRejectedValueOnce(new Error('github down'));
    const delivery = 'cccccccc-1111-2222-3333-dddddddddddd';

    const first = await POST(signed(payload(), { delivery }));
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());

    const retry = await POST(signed(payload(), { delivery }));
    expect(retry.status).toBe(202);
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(2);
  });

  it('answers 202 at once while the scan is still running', async () => {
    let finish: (v: unknown) => void = () => undefined;
    scanPRAndCommentMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const res = await POST(signed());
    expect(res.status).toBe(202);
    finish({});
  });

  it('answers a signed ping 200 without a scan', async () => {
    const res = await POST(signed({ zen: 'Keep it logically awesome.' }, { event: 'ping' }));
    expect(res.status).toBe(200);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindFirstMock).not.toHaveBeenCalled();
  });

  it('answers an unsigned ping 401', async () => {
    const res = await POST(signed({ zen: 'x' }, { event: 'ping', signature: null }));
    expect(res.status).toBe(401);
  });

  it.each(['push', 'issues', 'pull_request_review', null])(
    'ignores the %s event with 200',
    async (event) => {
      const res = await POST(signed(payload(), { event }));
      expect(res.status).toBe(200);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    },
  );

  it.each(['closed', 'reopened', 'edited', 'labeled'])(
    'ignores pull_request action %s with 200',
    async (action) => {
      const res = await POST(signed(payload({ action })));
      expect(res.status).toBe(200);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
      expect(repoFindFirstMock).not.toHaveBeenCalled();
    },
  );

  it('ignores a repository depsight does not track, with no scan', async () => {
    repoFindFirstMock.mockResolvedValue(null);
    const res = await POST(signed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'repository not tracked' });
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('does not consume the replay guard or the rate limit for an untracked repository', async () => {
    repoFindFirstMock.mockResolvedValueOnce(null);
    const delivery = 'eeeeeeee-1111-2222-3333-ffffffffffff';
    await POST(signed(payload(), { delivery }));
    const res = await POST(signed(payload(), { delivery }));
    expect(res.status).toBe(202);
  });

  it('never fetches a URL from the payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await POST(signed());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['owner with a slash', { repository: { name: 'api', owner: { login: 'acme/evil' } } }],
    ['repo with a slash', { repository: { name: '../api', owner: { login: 'acme' } } }],
    ['missing repository', { repository: undefined }],
    ['string number', { number: '42' }],
    ['zero number', { number: 0 }],
    ['fractional number', { number: 1.5 }],
  ])('answers 400 for %s', async (_name, over) => {
    const res = await POST(signed(payload(over)));
    expect(res.status).toBe(400);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindFirstMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a signed body that is not JSON', async () => {
    const res = await POST(makeRequest('not json'));
    expect(res.status).toBe(400);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a signed JSON null body', async () => {
    const res = await POST(makeRequest('null'));
    expect(res.status).toBe(400);
  });

  it.each([null, '', 'x', 'bad id with spaces and more than enough characters'])(
    'answers 400 for delivery id %j',
    async (delivery) => {
      const res = await POST(signed(payload(), { delivery }));
      expect(res.status).toBe(400);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    },
  );

  it('answers 413 for a body over the cap without a scan', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await POST(makeRequest(big));
    expect(res.status).toBe(413);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After once a repository passes its hourly budget', async () => {
    for (let i = 0; i < PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR; i++) {
      // A distinct PR number per delivery keeps each body unique for the replay guard.
      const res = await POST(signed(payload({ number: i + 1 })));
      expect(res.status).toBe(202);
    }
    const limited = await POST(signed(payload({ number: 9999 })));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR);
  });

  it('does not count unsigned requests against the rate limit', async () => {
    for (let i = 0; i < PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR + 5; i++) {
      await POST(signed(payload(), { signature: null }));
    }
    const res = await POST(signed());
    expect(res.status).toBe(202);
  });

  it('answers 429 once the endpoint-wide budget is spent', async () => {
    for (let i = 0; i < 600; i++) prScanWebhookTotalRateLimiter.check('all');
    const res = await POST(signed());
    expect(res.status).toBe(429);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });
});
