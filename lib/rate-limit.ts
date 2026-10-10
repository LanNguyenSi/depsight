/**
 * In-process fixed-window rate limiter.
 *
 * State lives in this Node process only. depsight runs as a single app
 * instance (one `app` service in docker-compose, and the auto-scan cron is
 * started in-process by instrumentation.ts), so a per-process counter is an
 * accurate per-user bound. If the app is ever scaled to several instances,
 * each instance enforces the limit on its own and the effective ceiling is
 * limit x instances; move the counter to a shared store at that point.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window after this call (0 when blocked). */
  remaining: number;
  /** Whole seconds until the window resets; always >= 1 when blocked. */
  retryAfterSeconds: number;
  /** When the window this call was counted in ends (epoch ms); identifies the window. */
  resetAt: number;
}

export interface RateLimiter {
  /** Count one request for `key` and report whether it is within the limit. */
  check(key: string): RateLimitResult;
  /** Forget every window (used by tests to isolate cases that share a limiter). */
  reset(): void;
}

interface Entry {
  count: number;
  resetAt: number;
}

/** Shared bucket for every key that arrives while a `maxKeys` limiter is full. */
export const OVERFLOW_KEY = '__overflow__';

/**
 * `maxKeys` bounds the memory of a limiter whose keys a caller can choose (an
 * IP read from a header): once that many windows are live, a new key is
 * counted in one shared overflow bucket instead of getting an entry of its
 * own. Without it the key space is the user table, so no eviction is needed.
 */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  const { limit, windowMs, maxKeys } = options;
  // One small entry per key that ever called, replaced when its window lapses.
  const entries = new Map<string, Entry>();
  let lastSweep = 0;

  /** Drop lapsed windows, at most once a second so a full map is not rescanned per request. */
  function sweep(now: number): void {
    if (now - lastSweep < 1000) return;
    lastSweep = now;
    for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
  }

  return {
    reset(): void {
      entries.clear();
      lastSweep = 0;
    },
    check(requestedKey: string): RateLimitResult {
      const now = Date.now();
      let key = requestedKey;
      if (maxKeys !== undefined && !entries.has(key) && entries.size >= maxKeys) {
        sweep(now);
        if (entries.size >= maxKeys) key = OVERFLOW_KEY;
      }
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        entries.set(key, entry);
      }

      if (entry.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
          resetAt: entry.resetAt,
        };
      }

      entry.count += 1;
      return {
        allowed: true,
        remaining: limit - entry.count,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
        resetAt: entry.resetAt,
      };
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;

// Per-user limits for the routes that spend the owner's GitHub quota. They cap
// a looping caller at a number of requests per endpoint per hour (requests,
// not GitHub API calls: one scan or sync can make several). They sit above the
// dashboard's "scan all" loop (scan, license, deps and one CI sync per tracked
// repo) and above a CI job that syncs on every push.
export const SCAN_LIMIT_PER_HOUR = 300;
export const CI_SYNC_REPO_LIMIT_PER_HOUR = 300;
export const CI_SYNC_ALL_LIMIT_PER_HOUR = 12;
// POST /api/license and POST /api/deps each scan one repo per call, like
// POST /api/scan, so they get the same ceiling, each with its own budget (the
// dashboard's "scan all" loop calls each of the three once per tracked repo).
export const LICENSE_LIMIT_PER_HOUR = 300;
export const DEPS_LIMIT_PER_HOUR = 300;
// GET /api/repos lists the owner's live GitHub repos (ceil(N/100) GitHub
// requests per call), so it gets the same ceiling.
export const REPOS_LIMIT_PER_HOUR = 300;

/** POST /api/scan, keyed by user id. */
export const scanRateLimiter = createRateLimiter({ limit: SCAN_LIMIT_PER_HOUR, windowMs: HOUR_MS });
/** POST /api/license, keyed by user id. */
export const licenseRateLimiter = createRateLimiter({
  limit: LICENSE_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});
/** POST /api/deps, keyed by user id. */
export const depsRateLimiter = createRateLimiter({
  limit: DEPS_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});
/** GET /api/repos, keyed by user id. */
export const reposRateLimiter = createRateLimiter({
  limit: REPOS_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});
/** POST /api/ci/sync with a repoId, keyed by user id. */
export const ciSyncRepoRateLimiter = createRateLimiter({
  limit: CI_SYNC_REPO_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});
/** POST /api/ci/sync without a repoId (30-day sync of every tracked repo), keyed by user id. */
export const ciSyncAllRateLimiter = createRateLimiter({
  limit: CI_SYNC_ALL_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});

// POST /api/webhooks/github is unauthenticated apart from its HMAC, so only a
// delivery verified against a tracked repository row's own secret reaches the
// three limiters below. Each accepted delivery starts a PR scan that spends the
// tracking user's own GitHub quota, so the per-row and per-user budgets are what
// bound the scan load. The endpoint-wide budget is a ceiling that protects the
// server, not a scan budget: it caps accepted deliveries (background scans and
// replay-guard memory, ~25 MB at the cap), while one user's rows can take at
// most 120 of it. They do not bound verification CPU: signature verification
// (one JSON parse of up to 1 MiB, measured at roughly 10-30 ms for a crafted body,
// plus up to 25 HMACs at about 0.35 ms per candidate per MiB) is bounded by the
// pre-verification limiters further down, which run before the body is read.
export const PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR = 60;
export const PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR = 3000;
// All of one user's tracked repositories together. Twice a single repository's
// budget, so ordinary use is untouched.
export const PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR = 120;

/** POST /api/webhooks/github, keyed by the verified Repo row id (one budget per tracking user). */
export const prScanWebhookRepoRateLimiter = createRateLimiter({
  limit: PR_SCAN_WEBHOOK_REPO_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});
/** POST /api/webhooks/github, keyed by the tracking user id (all of that user's rows). */
export const prScanWebhookUserRateLimiter = createRateLimiter({
  limit: PR_SCAN_WEBHOOK_USER_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});
/** POST /api/webhooks/github, one shared key for every repository. */
export const prScanWebhookTotalRateLimiter = createRateLimiter({
  limit: PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});

// Pre-verification limits for POST /api/webhooks/github. They run before the
// body is read, parsed or hashed, count every request (verified or not) and
// answer 429 without touching the body. Per source IP (see lib/client-ip.ts for
// which header is trusted) plus one endpoint-wide ceiling. Fixed one-minute
// windows. Legitimate traffic is a few deliveries a minute from GitHub's hook
// addresses, far below both figures. The ceiling is what still bounds the CPU
// when the client address cannot be trusted (an app reached without the proxy,
// where a caller can invent a new address per request): at the ceiling a
// crafted body costs roughly 25 s of CPU a minute at most. The per-IP table holds
// at most PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS windows; further addresses share one
// overflow bucket.
export const PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE = 60;
export const PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE = 600;
export const PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS = 10_000;
// Requests whose trusted client address lies in GitHub's published hook ranges
// (lib/github-hook-ranges.ts) are counted against this budget instead of the
// ceiling above, so traffic from other addresses cannot spend it. They still
// count against their own address first. Like the ceiling it bounds
// pre-verification work, so it adds to the worst case rather than replacing it.
export const PR_SCAN_WEBHOOK_PREAUTH_HOOK_LIMIT_PER_MINUTE = 300;
const MINUTE_MS = 60 * 1000;

/** POST /api/webhooks/github before verification, keyed by the trusted client address. */
export const prScanWebhookPreAuthIpRateLimiter = createRateLimiter({
  limit: PR_SCAN_WEBHOOK_PREAUTH_IP_LIMIT_PER_MINUTE,
  windowMs: MINUTE_MS,
  maxKeys: PR_SCAN_WEBHOOK_PREAUTH_MAX_IPS,
});
/** POST /api/webhooks/github before verification, one shared key for every caller. */
export const prScanWebhookPreAuthTotalRateLimiter = createRateLimiter({
  limit: PR_SCAN_WEBHOOK_PREAUTH_TOTAL_LIMIT_PER_MINUTE,
  windowMs: MINUTE_MS,
});
/** POST /api/webhooks/github before verification, one shared key for callers in GitHub's hook ranges. */
export const prScanWebhookPreAuthHookRateLimiter = createRateLimiter({
  limit: PR_SCAN_WEBHOOK_PREAUTH_HOOK_LIMIT_PER_MINUTE,
  windowMs: MINUTE_MS,
});

// POST /api/webhook-secrets/[repoId] mints (or rotates) a webhook secret. It is
// cheap, so the limit only stops a looping caller; one per repository a user
// sets up fits comfortably.
export const WEBHOOK_SECRET_LIMIT_PER_HOUR = 60;

/** POST /api/webhook-secrets/[repoId], keyed by user id. */
export const webhookSecretRateLimiter = createRateLimiter({
  limit: WEBHOOK_SECRET_LIMIT_PER_HOUR,
  windowMs: HOUR_MS,
});

/** Standard 429 response with a Retry-After header. */
export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: 'Rate limit exceeded', retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
  );
}
