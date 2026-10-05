/**
 * Client-side reading of the per-user rate limit answer (HTTP 429 with a
 * `Retry-After` header and a `{ error, retryAfterSeconds }` body) that the
 * scan, license, dependency and CI sync routes return. Pure helpers, so the
 * dashboard components stay thin wiring and the decisions are unit-testable.
 */

/** Used when a 429 carries neither a usable body value nor a Retry-After header. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

function positiveSeconds(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.ceil(value);
}

/**
 * Seconds to wait after a 429: the body's `retryAfterSeconds` wins, then the
 * `Retry-After` header (delta-seconds form), then DEFAULT_RETRY_AFTER_SECONDS.
 */
export function parseRetryAfterSeconds(body: unknown, retryAfterHeader: string | null): number {
  const fromBody =
    body !== null && typeof body === 'object'
      ? positiveSeconds((body as { retryAfterSeconds?: unknown }).retryAfterSeconds)
      : null;
  if (fromBody !== null) return fromBody;
  const fromHeader = retryAfterHeader === null ? null : positiveSeconds(retryAfterHeader);
  return fromHeader ?? DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Returns `{ retryAfterSeconds }` when the response is a 429, otherwise null.
 * Reads the body only for a 429, from a clone so the caller can still use it.
 */
export async function readRateLimit(
  res: Pick<Response, 'status' | 'headers' | 'clone'>,
): Promise<{ retryAfterSeconds: number } | null> {
  if (res.status !== 429) return null;
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    // Non-JSON body: fall back to the header.
  }
  return { retryAfterSeconds: parseRetryAfterSeconds(body, res.headers.get('Retry-After')) };
}

/**
 * Scan-all loop decision: for one step's response, the message to show when
 * the loop must stop (a 429, with `{seconds}` in the template replaced by the
 * retry time), or null when the loop may continue. Any other status, including
 * other failures, keeps the loop going as before.
 */
export async function scanAllStopMessage(
  res: Pick<Response, 'status' | 'headers' | 'clone'>,
  template: string,
): Promise<string | null> {
  const limit = await readRateLimit(res);
  if (!limit) return null;
  return template.split('{seconds}').join(String(limit.retryAfterSeconds));
}
