import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scanPRAndComment } from '@/lib/pr/pr-scanner';
import {
  MAX_BODY_BYTES,
  prWebhookDeliveries,
  readBodyCapped,
  verifyGitHubSignature,
} from '@/lib/pr/webhook-security';
import {
  prScanWebhookRepoRateLimiter,
  prScanWebhookTotalRateLimiter,
  rateLimitedResponse,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** pull_request actions that start a scan (`reopened` is deliberately not one). */
const SCAN_ACTIONS = new Set(['opened', 'synchronize']);

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const DELIVERY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

interface PullRequestPayload {
  action?: unknown;
  number?: unknown;
  repository?: { name?: unknown; owner?: { login?: unknown } };
}

function ignored(reason: string): NextResponse {
  return NextResponse.json({ ok: true, ignored: reason });
}

/**
 * POST /api/webhooks/github
 * GitHub `pull_request` webhook: runs the same PR scan as POST /api/pr-scan
 * and posts or updates the CVE comment, without a session. The HMAC of the
 * raw body (X-Hub-Signature-256, secret GITHUB_WEBHOOK_SECRET) is the only
 * authentication, so nothing but the capped body read happens before it is
 * verified, and nothing from the payload except the owner, repository name
 * and PR number is used (no URL from the payload is ever fetched).
 *
 * The scan runs in the background and the route answers 202 at once: GitHub
 * gives a delivery 10 seconds, a scan can take longer. depsight is a
 * long-lived Node server (`next start`), so the promise outlives the response.
 * The scan authenticates with the GitHub token of the user who tracks the
 * repository, as the auto-scan cron does.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || secret.trim() === '') {
    // Fail closed: without a configured secret every delivery is unverifiable.
    return NextResponse.json({ error: 'Webhook disabled' }, { status: 503 });
  }

  const rawBody = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!rawBody) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  if (!verifyGitHubSignature(rawBody, req.headers.get('x-hub-signature-256'), secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event');
  if (event === 'ping') return ignored('ping');
  if (event !== 'pull_request') return ignored('unsupported event');

  const delivery = req.headers.get('x-github-delivery') ?? '';
  if (!DELIVERY_PATTERN.test(delivery)) {
    return NextResponse.json({ error: 'Missing or invalid X-GitHub-Delivery' }, { status: 400 });
  }

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as PullRequestPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (payload === null || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  if (typeof payload.action !== 'string' || !SCAN_ACTIONS.has(payload.action)) {
    return ignored('unsupported action');
  }

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const prNumber = payload.number;
  if (
    typeof owner !== 'string' ||
    !OWNER_PATTERN.test(owner) ||
    typeof repo !== 'string' ||
    !REPO_PATTERN.test(repo) ||
    typeof prNumber !== 'number' ||
    !Number.isInteger(prNumber) ||
    prNumber < 1
  ) {
    return NextResponse.json(
      { error: 'Invalid repository or pull request number' },
      { status: 400 },
    );
  }

  // Only repositories a depsight user tracks are scanned. When several users
  // track one repository the oldest tracking row with a stored token is used.
  const tracked = await prisma.repo.findFirst({
    where: { owner, name: repo, tracked: true, user: { githubToken: { not: '' } } },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, user: { select: { githubToken: true } } },
  });
  if (!tracked) return ignored('repository not tracked');

  // Replay guard. The delivery id header is not covered by the signature, so a
  // replayed body could carry a fresh id; the body digest is therefore a second
  // key. Check, rate limit and remember with no await in between, so two
  // concurrent copies of one delivery cannot both pass.
  const deliveryKey = `delivery:${delivery}`;
  const bodyKey = `body:${createHash('sha256').update(rawBody).digest('hex')}`;
  if (prWebhookDeliveries.has(deliveryKey) || prWebhookDeliveries.has(bodyKey)) {
    return ignored('duplicate delivery');
  }

  const repoLimit = prScanWebhookRepoRateLimiter.check(`${owner}/${repo}`);
  if (!repoLimit.allowed) return rateLimitedResponse(repoLimit);
  const totalLimit = prScanWebhookTotalRateLimiter.check('all');
  if (!totalLimit.allowed) return rateLimitedResponse(totalLimit);

  prWebhookDeliveries.remember(deliveryKey);
  prWebhookDeliveries.remember(bodyKey);

  void scanPRAndComment(tracked.user.githubToken, owner, repo, prNumber, tracked.userId).catch(
    (error: unknown) => {
      // A failed scan must stay redeliverable, so its keys are released.
      prWebhookDeliveries.forget(deliveryKey);
      prWebhookDeliveries.forget(bodyKey);
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`PR scan webhook failed for ${owner}/${repo}#${prNumber}: ${message}`);
    },
  );

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 });
}
