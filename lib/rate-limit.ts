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

export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const { limit, windowMs } = options;
  // One small entry per user id that ever called, replaced when its window
  // lapses; the key space is the user table, so no eviction is needed.
  const entries = new Map<string, Entry>();

  return {
    reset(): void {
      entries.clear();
    },
    check(key: string): RateLimitResult {
      const now = Date.now();
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
        };
      }

      entry.count += 1;
      return {
        allowed: true,
        remaining: limit - entry.count,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;

// Per-user limits for the routes that spend the owner's GitHub quota. They are
// set well above the dashboard's "scan all" loop (one scan and one CI sync per
// tracked repo, run sequentially) and above a CI job that syncs on every push,
// while still stopping a looping token from draining the quota.
export const SCAN_LIMIT_PER_HOUR = 300;
export const CI_SYNC_REPO_LIMIT_PER_HOUR = 300;
export const CI_SYNC_ALL_LIMIT_PER_HOUR = 12;
// POST /api/license and POST /api/deps each scan one repo per call, like
// POST /api/scan, so they get the same ceiling, each with its own budget (the
// dashboard's "scan all" loop calls each of the three once per tracked repo).
export const LICENSE_LIMIT_PER_HOUR = 300;
export const DEPS_LIMIT_PER_HOUR = 300;

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

/** Standard 429 response with a Retry-After header. */
export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: 'Rate limit exceeded', retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
  );
}
