// Route-level tests for POST /api/webhooks/github (inbound GitHub webhook).
// No session: the HMAC under the tracked repository row's own secret is the
// only authentication. The scanner and prisma are mocked (prisma as a small
// in-memory table that applies the route's filters); sealing, signature, rate
// limiter and replay guard run for real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { scanPRAndCommentMock, repoFindManyMock } = vi.hoisted(() => ({
  scanPRAndCommentMock: vi.fn(),
  repoFindManyMock: vi.fn(),
}));

vi.mock('@/lib/pr/pr-scanner', () => ({ scanPRAndComment: scanPRAndCommentMock }));
vi.mock('@/lib/prisma', () => ({ prisma: { repo: { findMany: repoFindManyMock } } }));

import { POST } from '@/app/api/webhooks/github/route';
import { MAX_BODY_BYTES, prWebhookDeliveries } from '@/lib/pr/webhook-security';
import {
  prScanWebhookRepoRateLimiter,
  prScanWebhookTotalRateLimiter,
  prScanWebhookUserRateLimiter,
  PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR,
  PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR,
  PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR,
} from '@/lib/rate-limit';
import { sealWebhookSecret } from '@/lib/pr/webhook-secret';
import { NextRequest } from 'next/server';

const SECRET = 'test-webhook-secret';
const SECRET_B = 'user-b-webhook-secret';

interface Row {
  id: string;
  userId: string;
  owner: string;
  name: string;
  tracked: boolean;
  webhookSecretEnc: string | null;
  user: { githubToken: string };
  createdAt: number;
}

function row(over: Partial<Row> & { secret?: string | null } = {}): Row {
  const { secret, ...rest } = over;
  const id = rest.id ?? 'repo-row-1';
  const plain = secret === undefined ? SECRET : secret;
  return {
    id,
    userId: 'user-1',
    owner: 'acme',
    name: 'api',
    tracked: true,
    webhookSecretEnc: plain === null ? null : sealWebhookSecret(plain, id),
    user: { githubToken: 'tok-123' },
    createdAt: 1,
    ...rest,
  };
}

let table: Row[] = [];

/** Applies the filters the route passes, so a wrong filter shows up as a wrong result. */
function fakeFindMany(args: {
  where: {
    owner: string;
    name: string;
    tracked: boolean;
    webhookSecretEnc: { not: null };
    user: { githubToken: { not: string } };
  };
  take?: number;
}): Row[] {
  const w = args.where;
  return table
    .filter(
      (r) =>
        r.owner === w.owner &&
        r.name === w.name &&
        r.tracked === w.tracked &&
        r.webhookSecretEnc !== null &&
        r.user.githubToken !== w.user.githubToken.not,
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, args.take);
}

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
    pull_request: {
      url: 'http://169.254.169.254/latest/meta-data',
      head: { repo: { full_name: 'acme/api' } },
    },
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
    process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
    delete process.env.WEBHOOK_SECRET_KEY;
    scanPRAndCommentMock.mockReset();
    scanPRAndCommentMock.mockResolvedValue({ commented: true, newCVECount: 0, commentUrl: null });
    table = [row()];
    repoFindManyMock.mockReset();
    repoFindManyMock.mockImplementation(async (args) => fakeFindMany(args));
    prWebhookDeliveries.reset();
    prScanWebhookRepoRateLimiter.reset();
    prScanWebhookTotalRateLimiter.reset();
    prScanWebhookUserRateLimiter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.WEBHOOK_SECRET_KEY;
    delete process.env.GITHUB_WEBHOOK_SCAN_FORKS;
    vi.restoreAllMocks();
  });

  it('runs the PR scan with the tracking user token for a signed opened event', async () => {
    const res = await POST(signed());

    expect(res.status).toBe(202);
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
    expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-123', 'acme', 'api', 42, 'user-1');
  });

  it('looks the repository up among tracked rows that hold a secret, of users with a stored token', async () => {
    await POST(signed());

    expect(repoFindManyMock).toHaveBeenCalledTimes(1);
    const args = repoFindManyMock.mock.calls[0][0];
    expect(args.where).toEqual({
      owner: 'acme',
      name: 'api',
      tracked: true,
      webhookSecretEnc: { not: null },
      user: { githubToken: { not: '' } },
    });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.take).toBeGreaterThan(0);
  });

  it('also scans a synchronize event', async () => {
    const res = await POST(signed(payload({ action: 'synchronize' })));
    expect(res.status).toBe(202);
    expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
  });

  it('is disabled with 503 and never scans when no sealing key is configured', async () => {
    delete process.env.NEXTAUTH_SECRET;
    const res = await POST(signed());
    expect(res.status).toBe(503);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindManyMock).not.toHaveBeenCalled();
  });

  it('is disabled when the only key material is blank', async () => {
    process.env.NEXTAUTH_SECRET = '   ';
    const res = await POST(signed());
    expect(res.status).toBe(503);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('ignores the removed instance-wide GITHUB_WEBHOOK_SECRET variable', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'instance-wide';
    try {
      table = [row({ secret: null })];
      const res = await POST(signed(payload(), { secret: 'instance-wide' }));
      expect(res.status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    }
  });

  it('answers 401 without a scan for a missing signature', async () => {
    const res = await POST(signed(payload(), { signature: null }));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindManyMock).not.toHaveBeenCalled();
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
    const res = await POST(signed({ zen: 'Keep it logically awesome.', repository: payload().repository }, { event: 'ping' }));
    expect(res.status).toBe(200);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers an unsigned ping 401', async () => {
    const res = await POST(signed({ zen: 'x', repository: payload().repository }, { event: 'ping', signature: null }));
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
    },
  );

  it.each([
    ['an untracked repository', () => [row({ tracked: false })]],
    ['a repository with no secret set', () => [row({ secret: null })]],
    ['an unknown repository', () => [row({ owner: 'other', name: 'thing' })]],
    ['a user without a stored GitHub token', () => [row({ user: { githubToken: '' } })]],
    ['an empty table', () => []],
  ])('answers 401 with no scan and no oracle for %s', async (_name, rows) => {
    table = rows();
    const res = await POST(signed());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers a wrong signature and an unknown repository with the same body', async () => {
    const wrong = await POST(signed(payload(), { secret: 'wrong' }));
    table = [];
    const unknown = await POST(signed());
    expect(wrong.status).toBe(unknown.status);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('does not consume the replay guard or the rate limit for a rejected delivery', async () => {
    const delivery = 'eeeeeeee-1111-2222-3333-ffffffffffff';
    await POST(signed(payload(), { delivery, secret: 'wrong' }));
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
  ])('answers 401 without a lookup for %s (nothing to verify against)', async (_name, over) => {
    const res = await POST(signed(payload(over)));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    expect(repoFindManyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['string number', { number: '42' }],
    ['zero number', { number: 0 }],
    ['fractional number', { number: 1.5 }],
  ])('answers 400 for a signed %s', async (_name, over) => {
    const res = await POST(signed(payload(over)));
    expect(res.status).toBe(400);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers 401 for a body that is not JSON, even when signed', async () => {
    const res = await POST(makeRequest('not json'));
    expect(res.status).toBe(401);
    expect(scanPRAndCommentMock).not.toHaveBeenCalled();
  });

  it('answers 401 for a JSON null body', async () => {
    const res = await POST(makeRequest('null'));
    expect(res.status).toBe(401);
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

  describe('several users, one secret each', () => {
    const rowA = () =>
      row({ id: 'row-a', userId: 'user-a', secret: SECRET, user: { githubToken: 'tok-A' }, createdAt: 1 });
    const rowB = () =>
      row({ id: 'row-b', userId: 'user-b', secret: SECRET_B, user: { githubToken: 'tok-B' }, createdAt: 2 });

    it('scans under the user whose secret signed the delivery, for a repository both track', async () => {
      table = [rowA(), rowB()];

      const asB = await POST(signed(payload(), { secret: SECRET_B }));
      expect(asB.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
      expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-B', 'acme', 'api', 42, 'user-b');

      scanPRAndCommentMock.mockClear();
      const asA = await POST(signed(payload({ number: 43 }), { secret: SECRET }));
      expect(asA.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
      expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-A', 'acme', 'api', 43, 'user-a');
    });

    it("never lets user B's secret trigger a scan for a repository only user A tracks", async () => {
      table = [
        rowA(),
        row({
          id: 'row-b',
          userId: 'user-b',
          owner: 'bobs',
          name: 'own-repo',
          secret: SECRET_B,
          user: { githubToken: 'tok-B' },
        }),
      ];

      // B signs a delivery that names A's repository with B's own secret.
      const res = await POST(signed(payload(), { secret: SECRET_B }));

      expect(res.status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    });

    it("never lets user B's secret act for user A's row when A's row is the only candidate", async () => {
      table = [rowA()];
      const res = await POST(signed(payload(), { secret: SECRET_B }));
      expect(res.status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    });

    it('scans nothing when the signature matches neither tracking user', async () => {
      table = [rowA(), rowB()];
      const res = await POST(signed(payload(), { secret: 'a third secret' }));
      expect(res.status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    });

    it("does not open a sealed secret copied onto another user's row", async () => {
      const a = rowA();
      // B's row carries A's sealed value: sealed for row-a, so it cannot open under row-b.
      const forged = { ...rowB(), webhookSecretEnc: a.webhookSecretEnc };
      table = [forged];
      const res = await POST(signed(payload(), { secret: SECRET }));
      expect(res.status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    });

    it('treats a corrupt stored secret as not verifying, without throwing', async () => {
      table = [{ ...rowA(), webhookSecretEnc: 'not-a-sealed-value' }, rowB()];
      const res = await POST(signed(payload(), { secret: SECRET_B }));
      expect(res.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-B', 'acme', 'api', 42, 'user-b');
    });

    it('stops verifying a secret once it is removed or the row is untracked', async () => {
      table = [{ ...rowA(), webhookSecretEnc: null }];
      expect((await POST(signed())).status).toBe(401);
      table = [{ ...rowA(), tracked: false }];
      expect((await POST(signed())).status).toBe(401);
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
    });

    it("scopes the replay guard per row: B cannot burn A's delivery id or body", async () => {
      table = [rowA(), rowB()];
      const delivery = 'bbbbbbbb-1111-2222-3333-aaaaaaaaaaaa';

      // B pre-registers the id that GitHub will later use for A's real delivery.
      const first = await POST(signed(payload(), { delivery, secret: SECRET_B }));
      expect(first.status).toBe(202);

      // Same id, same body, signed by A: still A's first delivery.
      const second = await POST(signed(payload(), { delivery, secret: SECRET }));
      expect(second.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(2);
      expect(scanPRAndCommentMock).toHaveBeenLastCalledWith('tok-A', 'acme', 'api', 42, 'user-a');
    });

    it("scopes the rate limit per row: B exhausting its budget leaves A's untouched", async () => {
      table = [rowA(), rowB()];
      for (let i = 0; i < PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR; i++) {
        const res = await POST(signed(payload({ number: i + 1 }), { secret: SECRET_B }));
        expect(res.status).toBe(202);
      }
      const limited = await POST(signed(payload({ number: 9999 }), { secret: SECRET_B }));
      expect(limited.status).toBe(429);

      const asA = await POST(signed(payload({ number: 1 }), { secret: SECRET }));
      expect(asA.status).toBe(202);
    });

    it('bounds how many candidate rows one delivery makes the server try', async () => {
      table = [rowA(), rowB()];
      await POST(signed(payload(), { secret: SECRET_B }));
      const args = repoFindManyMock.mock.calls[0][0];
      expect(args.take).toBeLessThanOrEqual(50);
    });

    it("caps one user's rows together, so one tenant cannot spend the endpoint-wide budget", async () => {
      // One user tracks two repositories, each with its own 60 per hour; together they get 120.
      table = [
        row({ id: 'row-1', userId: 'user-a', name: 'one', secret: SECRET, user: { githubToken: 'tok-A' } }),
        row({ id: 'row-2', userId: 'user-a', name: 'two', secret: SECRET, user: { githubToken: 'tok-A' } }),
        row({ id: 'row-x', userId: 'user-b', name: 'other', secret: SECRET_B, user: { githubToken: 'tok-B' } }),
      ];
      const repoOf = (name: string, number: number) =>
        payload({
          number,
          repository: { name, owner: { login: 'acme' } },
          pull_request: { head: { repo: { full_name: `acme/${name}` } } },
        });
      for (let i = 0; i < PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR; i++) {
        const name = i % 2 === 0 ? 'one' : 'two';
        expect((await POST(signed(repoOf(name, i + 1), { secret: SECRET }))).status).toBe(202);
      }
      // Neither repository budget is spent (60 each) yet the user budget is.
      const limited = await POST(signed(repoOf('one', 9999), { secret: SECRET }));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR);

      // Another user still scans, and the capped user's 429 did not use up the whole-endpoint budget.
      expect((await POST(signed(repoOf('other', 1), { secret: SECRET_B }))).status).toBe(202);
      expect(prScanWebhookTotalRateLimiter.check('all').remaining).toBe(
        PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR - (PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR + 1) - 1,
      );
    });
  });

  describe('fork pull requests', () => {
    const withHead = (head: unknown) =>
      payload({ pull_request: { url: 'http://x.invalid', head } });

    /** A verified fork delivery is ignored and spends no replay-guard entry and no scan budget. */
    async function expectIgnoredFork(body: Record<string, unknown>) {
      const res = await POST(signed(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: 'fork pull request' });
      expect(scanPRAndCommentMock).not.toHaveBeenCalled();
      expect(prWebhookDeliveries.size()).toBe(0);
      // Each check below spends one unit itself, so a full remainder minus one
      // means the ignored delivery spent none.
      expect(prScanWebhookRepoRateLimiter.check('repo-row-1').remaining).toBe(
        PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR - 1,
      );
      expect(prScanWebhookUserRateLimiter.check('user-1').remaining).toBe(
        PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR - 1,
      );
      expect(prScanWebhookTotalRateLimiter.check('all').remaining).toBe(
        PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR - 1,
      );
    }

    it('ignores a pull request from a fork by default', async () => {
      await expectIgnoredFork(withHead({ repo: { full_name: 'mallory/api' } }));
    });

    it('ignores a pull request whose fork was deleted (head.repo is null)', async () => {
      await expectIgnoredFork(withHead({ repo: null }));
    });

    it('ignores a payload that does not describe its head repository', async () => {
      await expectIgnoredFork(payload({ pull_request: {} }));
    });

    it('scans a same-repository pull request that differs only in letter case', async () => {
      const res = await POST(signed(withHead({ repo: { full_name: 'ACME/Api' } })));
      expect(res.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
    });

    it('scans a same-repository pull request whose base owner and name are mixed case', async () => {
      // GitHub reports the canonical case in both places; the tracked row stores it too.
      table = [row({ owner: 'Acme', name: 'Api' })];
      for (const headFullName of ['acme/api', 'Acme/Api']) {
        scanPRAndCommentMock.mockClear();
        const res = await POST(
          signed(
            payload({
              repository: { name: 'Api', owner: { login: 'Acme' } },
              pull_request: {
                url: 'http://x.invalid',
                head: { repo: { full_name: headFullName } },
              },
            }),
          ),
        );
        expect(res.status).toBe(202);
        expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
        expect(scanPRAndCommentMock).toHaveBeenLastCalledWith('tok-123', 'Acme', 'Api', 42, 'user-1');
      }
    });

    it('scans fork pull requests when GITHUB_WEBHOOK_SCAN_FORKS is true', async () => {
      process.env.GITHUB_WEBHOOK_SCAN_FORKS = ' TRUE ';
      const res = await POST(signed(withHead({ repo: null })));
      expect(res.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
    });

    it('keeps ignoring forks for any value other than true', async () => {
      process.env.GITHUB_WEBHOOK_SCAN_FORKS = '1';
      await expectIgnoredFork(withHead({ repo: { full_name: 'mallory/api' } }));
    });

    it('still answers 401 for an unsigned fork delivery', async () => {
      const res = await POST(
        signed(withHead({ repo: { full_name: 'mallory/api' } }), { signature: null }),
      );
      expect(res.status).toBe(401);
    });

    it('answers a fork delivery signed with the wrong secret 401, not the fork answer (no oracle)', async () => {
      const res = await POST(
        signed(withHead({ repo: { full_name: 'mallory/api' } }), { secret: 'wrong' }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid signature' });
    });

    it.each([
      ['untracked', () => [row({ tracked: false })]],
      ['without a secret', () => [row({ secret: null })]],
      ['unknown', () => []],
    ])('answers a fork delivery for a repository that is %s 401, like any other', async (_n, rows) => {
      table = rows();
      const res = await POST(signed(withHead({ repo: { full_name: 'mallory/api' } })));
      expect(res.status).toBe(401);
    });

    it('does not remember an ignored fork delivery, so the same id can still scan afterwards', async () => {
      const delivery = 'ffffffff-1111-2222-3333-000000000001';
      const fork = await POST(
        signed(withHead({ repo: { full_name: 'mallory/api' } }), { delivery }),
      );
      expect(fork.status).toBe(200);
      const same = await POST(signed(payload(), { delivery }));
      expect(same.status).toBe(202);
    });

    it("keeps one user's fork check on that user's row: B's secret over a fork body scans nothing for A", async () => {
      table = [
        row({ id: 'row-a', userId: 'user-a', secret: SECRET, user: { githubToken: 'tok-A' }, createdAt: 1 }),
        row({ id: 'row-b', userId: 'user-b', secret: SECRET_B, user: { githubToken: 'tok-B' }, createdAt: 2 }),
      ];
      process.env.GITHUB_WEBHOOK_SCAN_FORKS = 'true';
      const res = await POST(
        signed(withHead({ repo: { full_name: 'mallory/api' } }), { secret: SECRET_B }),
      );
      expect(res.status).toBe(202);
      expect(scanPRAndCommentMock).toHaveBeenCalledTimes(1);
      expect(scanPRAndCommentMock).toHaveBeenCalledWith('tok-B', 'acme', 'api', 42, 'user-b');
    });
  });
});
