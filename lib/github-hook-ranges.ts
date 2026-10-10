import { cidrContains, parseAddress, parseCidr, type Cidr } from '@/lib/ip-cidr';

/**
 * GitHub's published webhook source ranges (the `hooks` key of
 * https://api.github.com/meta), cached in this process.
 *
 * The unauthenticated PR-scan webhook gives requests from these addresses a
 * pre-verification budget of their own. The ranges only ever make that budget
 * available to more addresses, never fewer, so every failure path ends in "not
 * a GitHub address" and the endpoint keeps its single ceiling:
 *
 * - nothing is fetched at import time; the first request that needs a
 *   classification starts one fetch in the background and is classified
 *   without the ranges;
 * - at most one fetch is in flight, it is bounded by a timeout, and a fetch
 *   that failed is not retried before RETRY_MS has passed;
 * - ranges are refreshed once they are older than TTL_MS, and a set that could
 *   not be refreshed is dropped after STALE_MS;
 * - the response is read with a byte cap before it is parsed, and an entry
 *   wider than a sanity floor (a /0, say) is dropped.
 */

export const GITHUB_META_URL = 'https://api.github.com/meta';
/** Ranges older than this are refreshed (the next request starts a fetch). */
export const HOOK_RANGES_TTL_MS = 60 * 60 * 1000;
/** Ranges that could not be refreshed for this long are dropped. */
export const HOOK_RANGES_STALE_MS = 24 * 60 * 60 * 1000;
/** Wait after a failed fetch before the next attempt. */
export const HOOK_RANGES_RETRY_MS = 5 * 60 * 1000;
/** A fetch that has not answered by then is abandoned. */
export const HOOK_RANGES_FETCH_TIMEOUT_MS = 5000;
/** GitHub publishes a few dozen hook ranges; a response with more is not trusted. */
const MAX_RANGES = 500;
/**
 * The meta document is about 150 KiB, mostly its actions list; a response
 * larger than this (declared or read) is not parsed, so a hostile or broken
 * answer cannot make the server buffer and parse an unbounded body.
 */
export const HOOK_RANGES_MAX_BODY_BYTES = 2 * 1024 * 1024;
/**
 * Sanity floor on a range's prefix length. An entry wider than this (a /0, or
 * any block no webhook sender occupies) would put most of the Internet into the
 * hook class, so it is dropped as if it were malformed.
 */
export const MIN_HOOK_PREFIX_IPV4 = 8;
export const MIN_HOOK_PREFIX_IPV6 = 16;

export interface HookRanges {
  /**
   * Whether `ip` lies in GitHub's hook ranges. False for anything else,
   * including every address while no usable ranges are cached. Never blocks
   * and never throws; may start a background fetch.
   */
  contains(ip: string): boolean;
  /** Fetch now unless a fetch is already in flight; resolves when it is done and never rejects. */
  refresh(): Promise<void>;
  /** Forget the cached ranges and any retry delay (used by tests). */
  reset(): void;
}

export interface HookRangesOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  staleMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

/**
 * The text of a response body, read with a byte cap: refused when Content-Length
 * declares more than `maxBytes`, and cancelled as soon as more than `maxBytes`
 * have arrived, before anything is parsed.
 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('response too large');
  }
  if (!res.body) throw new Error('empty response');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The usable CIDRs of a meta response's `hooks` list, or null when there are none to use. */
function parseHooks(body: unknown): Cidr[] | null {
  const hooks = (body as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks) || hooks.length > MAX_RANGES) return null;
  const cidrs: Cidr[] = [];
  for (const entry of hooks) {
    const cidr = typeof entry === 'string' ? parseCidr(entry) : null;
    if (!cidr) continue;
    if (cidr.prefix < (cidr.family === 4 ? MIN_HOOK_PREFIX_IPV4 : MIN_HOOK_PREFIX_IPV6)) continue;
    cidrs.push(cidr);
  }
  return cidrs.length > 0 ? cidrs : null;
}

export function createHookRanges(options: HookRangesOptions = {}): HookRanges {
  // Looked up per call so a test (or a runtime) that replaces global fetch is honoured.
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HOOK_RANGES_TTL_MS;
  const staleMs = options.staleMs ?? HOOK_RANGES_STALE_MS;
  const retryMs = options.retryMs ?? HOOK_RANGES_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? HOOK_RANGES_FETCH_TIMEOUT_MS;

  let ranges: Cidr[] | null = null;
  let fetchedAt = 0;
  let nextAttemptAt = 0;
  let inflight: Promise<void> | null = null;
  let warnedFailure = false;

  async function load(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(GITHUB_META_URL, {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'depsight' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseHooks(JSON.parse(await readTextCapped(res, HOOK_RANGES_MAX_BODY_BYTES)));
      if (!parsed) throw new Error('no usable hooks ranges in the response');
      ranges = parsed;
      fetchedAt = now();
      nextAttemptAt = 0;
      warnedFailure = false;
    } catch (err) {
      nextAttemptAt = now() + retryMs;
      if (!warnedFailure) {
        warnedFailure = true;
        console.warn(
          `PR scan webhook: could not fetch GitHub's hook address ranges (${err instanceof Error ? err.message : 'unknown error'}); ` +
            'requests share the single pre-verification ceiling until a fetch succeeds',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(): Promise<void> {
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    contains(ip: string): boolean {
      // Not an address (the limiter's `unknown` key): nothing to classify, nothing to fetch for.
      const address = parseAddress(ip);
      if (!address) return false;
      const t = now();
      if (ranges && t - fetchedAt >= staleMs) ranges = null;
      if ((!ranges || t - fetchedAt >= ttlMs) && !inflight && t >= nextAttemptAt) {
        void refresh();
      }
      return ranges !== null && ranges.some((cidr) => cidrContains(cidr, address));
    },
    refresh,
    reset(): void {
      ranges = null;
      fetchedAt = 0;
      nextAttemptAt = 0;
      warnedFailure = false;
    },
  };
}

/** The process-wide instance the webhook route classifies callers with. */
export const githubHookRanges = createHookRanges();
