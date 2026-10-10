import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scanPRAndComment } from '@/lib/pr/pr-scanner';
import {
  MAX_BODY_BYTES,
  hasWellFormedSignature,
  prWebhookDeliveries,
  readBodyCapped,
  verifyGitHubSignature,
} from '@/lib/pr/webhook-security';
import { getWebhookSecretKey, openWebhookSecret } from '@/lib/pr/webhook-secret';
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

/**
 * Upper bound on tracking rows tried per delivery. Every candidate costs one
 * HMAC over the body, and the lookup runs before the signature is verified, so
 * the number of rows an unauthenticated request can make the server try is
 * capped. Far above the number of users that track one repository.
 */
const MAX_CANDIDATES = 25;

/** Stand-in secret so a delivery for an unknown repository costs one HMAC like any other. */
const DUMMY_SECRET = 'depsight-no-such-webhook-secret';

function ignored(reason: string): NextResponse {
  return NextResponse.json({ ok: true, ignored: reason });
}

function invalidSignature(): NextResponse {
  // One answer for every reason a delivery cannot be tied to a secret: no or
  // malformed signature, unreadable body, unknown or untracked repository,
  // repository without a webhook secret, wrong secret. It must not say which.
  return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
}

/** Parsed payload plus the owner and repository name it claims, or null when it names none. */
function claimedRepository(
  rawBody: Buffer,
): { owner: string; repo: string; payload: PullRequestPayload } | null {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as PullRequestPayload;
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  if (
    typeof owner !== 'string' ||
    !OWNER_PATTERN.test(owner) ||
    typeof repo !== 'string' ||
    !REPO_PATTERN.test(repo)
  ) {
    return null;
  }
  return { owner, repo, payload };
}

/**
 * POST /api/webhooks/github
 * GitHub `pull_request` webhook: runs the same PR scan as POST /api/pr-scan
 * and posts or updates the CVE comment, without a session.
 *
 * Authentication is the HMAC of the raw body (X-Hub-Signature-256) under the
 * secret of the tracked repository the delivery names. Each tracking user has
 * their own secret per repository (Repo.webhookSecretEnc, minted in settings),
 * so a delivery acts only for the user(s) whose secret verifies it: the
 * secret of user B never triggers a scan, or a comment under the token, of
 * user A, even for a repository both track. There is no instance-wide secret.
 *
 * The payload is parsed before the signature is checked, but only to read the
 * owner and repository name for the candidate lookup; the lookup result is
 * discarded unless a secret verifies. Nothing else from the payload is used
 * before verification, and after it only the PR number and action (no URL from
 * the payload is ever fetched).
 *
 * The scan runs in the background and the route answers 202 at once: GitHub
 * gives a delivery 10 seconds, a scan can take longer. depsight is a
 * long-lived Node server (`next start`), so the promise outlives the response.
 * The scan authenticates with the GitHub token of the user whose secret
 * verified the delivery.
 */
export async function POST(req: NextRequest) {
  if (!getWebhookSecretKey()) {
    // Fail closed: without a sealing key no stored secret can be opened.
    return NextResponse.json({ error: 'Webhook disabled' }, { status: 503 });
  }

  const rawBody = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!rawBody) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  // A delivery without a well-formed signature cannot verify against anything:
  // reject it before any parsing or database work.
  const signature = req.headers.get('x-hub-signature-256');
  if (!hasWellFormedSignature(signature)) return invalidSignature();

  const claimed = claimedRepository(rawBody);
  if (!claimed) return invalidSignature();
  const { owner, repo, payload } = claimed;

  // Tracking rows of this repository that hold a webhook secret, oldest first.
  const candidates = await prisma.repo.findMany({
    where: {
      owner,
      name: repo,
      tracked: true,
      webhookSecretEnc: { not: null },
      user: { githubToken: { not: '' } },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      userId: true,
      owner: true,
      name: true,
      webhookSecretEnc: true,
      user: { select: { githubToken: true } },
    },
  });

  // Try every candidate (no early exit, so the work does not depend on which
  // row matches). A secret that cannot be opened never verifies.
  const verified: typeof candidates = [];
  if (candidates.length === 0) verifyGitHubSignature(rawBody, signature, DUMMY_SECRET);
  for (const candidate of candidates) {
    const secret = candidate.webhookSecretEnc
      ? openWebhookSecret(candidate.webhookSecretEnc, candidate.id)
      : null;
    if (secret && verifyGitHubSignature(rawBody, signature, secret)) verified.push(candidate);
  }
  // Secrets are random per row, so two rows verifying one body would mean one
  // user knows another's secret; either way the oldest verified row acts alone.
  const tracked = verified[0];
  if (!tracked) return invalidSignature();

  const event = req.headers.get('x-github-event');
  if (event === 'ping') return ignored('ping');
  if (event !== 'pull_request') return ignored('unsupported event');

  const delivery = req.headers.get('x-github-delivery') ?? '';
  if (!DELIVERY_PATTERN.test(delivery)) {
    return NextResponse.json({ error: 'Missing or invalid X-GitHub-Delivery' }, { status: 400 });
  }

  if (typeof payload.action !== 'string' || !SCAN_ACTIONS.has(payload.action)) {
    return ignored('unsupported action');
  }

  const prNumber = payload.number;
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber < 1) {
    return NextResponse.json({ error: 'Invalid pull request number' }, { status: 400 });
  }

  // Replay guard. The delivery id header is not covered by the signature, so a
  // replayed body could carry a fresh id; the body digest is therefore a second
  // key. Both keys are scoped to the verified row: otherwise a user holding a
  // valid secret for their own repository could pre-register a delivery id (or
  // body) and make a later, genuine delivery of another user answer "duplicate".
  // Check, rate limit and remember with no await in between, so two concurrent
  // copies of one delivery cannot both pass.
  const deliveryKey = `delivery:${tracked.id}:${delivery}`;
  const bodyKey = `body:${tracked.id}:${createHash('sha256').update(rawBody).digest('hex')}`;
  if (prWebhookDeliveries.has(deliveryKey) || prWebhookDeliveries.has(bodyKey)) {
    return ignored('duplicate delivery');
  }

  // The repository budget is per tracking row, so one user's deliveries never
  // spend another user's budget for the same repository.
  const repoLimit = prScanWebhookRepoRateLimiter.check(tracked.id);
  if (!repoLimit.allowed) return rateLimitedResponse(repoLimit);
  const totalLimit = prScanWebhookTotalRateLimiter.check('all');
  if (!totalLimit.allowed) return rateLimitedResponse(totalLimit);

  prWebhookDeliveries.remember(deliveryKey);
  prWebhookDeliveries.remember(bodyKey);

  void scanPRAndComment(
    tracked.user.githubToken,
    tracked.owner,
    tracked.name,
    prNumber,
    tracked.userId,
  ).catch((error: unknown) => {
    // A failed scan must stay redeliverable, so its keys are released.
    prWebhookDeliveries.forget(deliveryKey);
    prWebhookDeliveries.forget(bodyKey);
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`PR scan webhook failed for ${tracked.owner}/${tracked.name}#${prNumber}: ${message}`);
  });

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 });
}
