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
import {
  getWebhookSecretKey,
  openWebhookSecret,
  unreadableSecretWarning,
  IGNORED_INSTANCE_SECRET_WARNING,
} from '@/lib/pr/webhook-secret';
import { clientIpFromForwardedFor, trustedProxyHops } from '@/lib/client-ip';
import {
  PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE,
  prScanWebhookPreAuthIpRateLimiter,
  prScanWebhookPreAuthTotalRateLimiter,
  prScanWebhookRepoRateLimiter,
  prScanWebhookTotalRateLimiter,
  prScanWebhookUserRateLimiter,
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
  repository?: { name?: unknown; owner?: { login?: unknown }; private?: unknown; visibility?: unknown };
  pull_request?: { head?: { repo?: { full_name?: unknown } | null } | null } | null;
}

/**
 * True when the pull request comes from a fork. A missing or deleted head
 * repository (`head.repo` is null once a fork is deleted) counts as a fork, and
 * so does any head the payload does not describe, so the opt-out fails closed.
 * Repository names are case-insensitive on GitHub, hence the lowercase compare.
 */
function isForkPullRequest(payload: PullRequestPayload, owner: string, repo: string): boolean {
  const headFullName = payload.pull_request?.head?.repo?.full_name;
  if (typeof headFullName !== 'string') return true;
  return headFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase();
}

/**
 * True only when the payload says the repository is private. Visibility is
 * judged from this delivery, not from the stored `Repo.private`, so a
 * private-to-public flip applies to the very next delivery without waiting for
 * a sync. A missing, mistyped or contradictory field counts as public, so the
 * check fails safe.
 */
function isPrivateRepository(payload: PullRequestPayload): boolean {
  const repository = payload.repository;
  const flag = typeof repository?.private === 'boolean' ? repository.private : undefined;
  const visibility = repository?.visibility;
  const fromVisibility =
    visibility === 'private' || visibility === 'internal'
      ? true
      : visibility === 'public'
        ? false
        : undefined;
  if (flag === undefined && fromVisibility === undefined) return false;
  if (flag !== undefined && fromVisibility !== undefined && flag !== fromVisibility) return false;
  return flag ?? fromVisibility ?? false;
}

/**
 * Whether fork pull requests are scanned for one tracking row. The row's own
 * setting (set by its owner) wins; null follows the instance default
 * GITHUB_WEBHOOK_SCAN_FORKS, which scans forks only when it is `true`. The
 * argument is the verified row alone, so one row's opt-in never reaches the
 * row of another owner that tracks the same GitHub repository. On a public
 * repository the row's opt-in is ignored (an explicit opt-out still holds), so
 * a repository that became public stops scanning outsiders' forks on its own.
 */
function scansForks(row: { webhookScanForks: boolean | null }, isPrivate: boolean): boolean {
  const instanceDefault = process.env.GITHUB_WEBHOOK_SCAN_FORKS?.trim().toLowerCase() === 'true';
  if (row.webhookScanForks === null) return instanceDefault;
  if (!isPrivate && row.webhookScanForks) return instanceDefault;
  return row.webhookScanForks;
}

/** The operator switched the endpoint off (GITHUB_WEBHOOK_DISABLED=true). */
function webhookDisabled(): boolean {
  return process.env.GITHUB_WEBHOOK_DISABLED?.trim().toLowerCase() === 'true';
}

/** Limiter key for a caller whose address cannot be established from a trusted hop. */
const UNKNOWN_CLIENT = 'unknown';

/** End of the endpoint-wide window that was last reported (its resetAt, epoch ms). */
let ceilingWarnedWindow = 0;

/**
 * The endpoint-wide pre-verification ceiling refused a request, which may be a
 * GitHub delivery that GitHub does not redeliver by itself. Say so once per
 * limiter window (keyed by the window's end, so the first refusal of every
 * window is logged); the log line carries no request data.
 */
function warnCeilingReached(windowResetAt: number): void {
  if (windowResetAt === ceilingWarnedWindow) return;
  ceilingWarnedWindow = windowResetAt;
  console.warn(
    `PR scan webhook: the endpoint-wide pre-verification limit (${PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE} requests a minute) was reached; ` +
      'requests are answered 429 until the window ends and GitHub does not redeliver them automatically',
  );
}

/**
 * Limits applied before anything of the request is read: per trusted client
 * address, then one endpoint-wide ceiling. Returns the 429 to send, or null.
 * The address comes only from the hop the trusted proxy appended to
 * X-Forwarded-For (see lib/client-ip.ts); a caller that is not behind the
 * proxy can write that value itself, and what still bounds it is the shared
 * ceiling and the capped size of the per-address table.
 */
function preAuthRateLimited(req: NextRequest): Response | null {
  const ip =
    clientIpFromForwardedFor(req.headers.get('x-forwarded-for'), trustedProxyHops()) ??
    UNKNOWN_CLIENT;
  const ipLimit = prScanWebhookPreAuthIpRateLimiter.check(ip);
  if (!ipLimit.allowed) return rateLimitedResponse(ipLimit);
  const totalLimit = prScanWebhookPreAuthTotalRateLimiter.check('all');
  if (!totalLimit.allowed) {
    warnCeilingReached(totalLimit.resetAt);
    return rateLimitedResponse(totalLimit);
  }
  return null;
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

/**
 * Row ids whose stored secret failed to open, already warned about in this
 * process. One warning per row keeps the log readable however often GitHub
 * delivers; the id is the only thing logged (never key material, the stored
 * value or the payload).
 */
const warnedUnreadableRows = new Set<string>();

function warnUnreadableOnce(rowId: string): void {
  if (warnedUnreadableRows.has(rowId)) return;
  warnedUnreadableRows.add(rowId);
  console.warn(unreadableSecretWarning(rowId));
}

let warnedInstanceSecret = false;

/** The instance-wide GITHUB_WEBHOOK_SECRET is gone; say so once instead of failing every delivery in silence. */
function warnIgnoredInstanceSecretOnce(): void {
  if (warnedInstanceSecret) return;
  warnedInstanceSecret = true;
  if (!process.env.GITHUB_WEBHOOK_SECRET?.trim()) return;
  console.warn(IGNORED_INSTANCE_SECRET_WARNING);
}

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
 * Before the body is read, a per-address limit (the client address is the hop
 * the trusted proxy appended to X-Forwarded-For) and an endpoint-wide ceiling
 * bound what an unauthenticated caller can make the server parse and hash.
 * GITHUB_WEBHOOK_DISABLED=true switches the endpoint off (404, body unread).
 *
 * The payload is parsed before the signature is checked, but only to read the
 * owner and repository name for the candidate lookup; the lookup result is
 * discarded unless a secret verifies. Nothing else from the payload is used
 * before verification, and after it only the PR number and action (no URL from
 * the payload is ever fetched).
 *
 * Pull requests from forks are ignored (200) unless the repository is private
 * and the verified row's owner opted in (Repo.webhookScanForks), or
 * GITHUB_WEBHOOK_SCAN_FORKS is `true` and the row has no setting (or opted in
 * on a public repository, where the opt-in is ignored), because on a public
 * repository any outsider can open one and the comment publishes alert data.
 *
 * The scan runs in the background and the route answers 202 at once: GitHub
 * gives a delivery 10 seconds, a scan can take longer. depsight is a
 * long-lived Node server (`next start`), so the promise outlives the response.
 * The scan authenticates with the GitHub token of the user whose secret
 * verified the delivery.
 */
export async function POST(req: NextRequest) {
  // The operator opt-out answers before anything else, body unread.
  if (webhookDisabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  warnIgnoredInstanceSecretOnce();
  if (!getWebhookSecretKey()) {
    // Fail closed: without a sealing key no stored secret can be opened.
    return NextResponse.json({ error: 'Webhook disabled' }, { status: 503 });
  }

  // Cheap rejection first: over the per-address or endpoint-wide pre-verification
  // limit the request is answered 429 without its body being read, parsed or
  // hashed. Every later step (body read, JSON parse, lookup, HMACs) costs more.
  const tooMany = preAuthRateLimited(req);
  if (tooMany) return tooMany;

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
      webhookScanForks: true,
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
    if (candidate.webhookSecretEnc && secret === null) warnUnreadableOnce(candidate.id);
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

  // Fork pull requests are ignored (200) unless the operator opted in (a
  // per-row opt-in counts only for a private repository, judged from this
  // delivery's payload; see scansForks). This
  // sits after the signature check, so only a verified caller can ever see this
  // answer and it tells an unverified one nothing, and before the replay guard
  // and the rate limiters, so a fork delivery spends no scan budget.
  if (!scansForks(tracked, isPrivateRepository(payload)) && isForkPullRequest(payload, tracked.owner, tracked.name)) {
    return ignored('fork pull request');
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
  // One user's rows together are capped too, so one tenant cannot spend the
  // endpoint-wide ceiling however many repositories they track.
  const userLimit = prScanWebhookUserRateLimiter.check(tracked.userId);
  if (!userLimit.allowed) return rateLimitedResponse(userLimit);
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
