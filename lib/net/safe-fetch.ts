import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import net from 'net';
import type { LookupFunction } from 'net';

/**
 * SSRF guard for user-supplied outbound URLs (webhook / Slack endpoints).
 *
 * Rejects:
 *  - non-http(s) protocols
 *  - hostnames that resolve to loopback, link-local, RFC1918 private,
 *    unique-local (IPv6), or cloud-metadata (169.254.169.254) ranges
 *
 * Returns the set of resolved public IPs so callers can pin the connection
 * and defeat DNS-rebinding (resolve once, connect to the same address).
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Parse an IPv4 dotted-quad into its 32-bit unsigned integer value. */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (cidr: string): boolean => {
    const [base, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0/8') || // "this" network
    inRange('10.0.0.0/8') || // RFC1918
    inRange('100.64.0.0/10') || // CGNAT
    inRange('127.0.0.0/8') || // loopback
    inRange('169.254.0.0/16') || // link-local + cloud metadata (169.254.169.254)
    inRange('172.16.0.0/12') || // RFC1918
    inRange('192.0.0.0/24') || // IETF protocol assignments
    inRange('192.168.0.0/16') || // RFC1918
    inRange('198.18.0.0/15') || // benchmarking
    inRange('224.0.0.0/4') || // multicast
    inRange('240.0.0.0/4') // reserved
  );
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 literal
 * (::ffff:0:0/96), in either the dotted-quad form (::ffff:10.0.0.1) or the
 * compressed-hex form (::ffff:a00:1). The latter is what `new URL(...)`
 * canonicalizes bracketed IPv4-mapped literals to, so both must be handled
 * for the synchronous literal-IP branch to catch them.
 */
function mappedIPv4FromIPv6(addr: string): string | null {
  const dotted = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (hi > 0xffff || lo > 0xffff) return null;
    const combined = (hi << 16) | lo;
    return [
      (combined >>> 24) & 0xff,
      (combined >>> 16) & 0xff,
      (combined >>> 8) & 0xff,
      combined & 0xff,
    ].join('.');
  }

  return null;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:a00:1) — evaluate the embedded IPv4.
  const mapped = mappedIPv4FromIPv6(addr);
  if (mapped) return isPrivateIPv4(mapped);
  return (
    addr === '::' ||
    addr === '::1' || // loopback
    addr.startsWith('fc') || // unique-local fc00::/7
    addr.startsWith('fd') ||
    addr.startsWith('fe8') || // link-local fe80::/10
    addr.startsWith('fe9') ||
    addr.startsWith('fea') ||
    addr.startsWith('feb')
  );
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  // Unrecognised address form: fail closed.
  return true;
}

/**
 * Cap on concurrent `dns.lookup` calls for user-configured host names.
 *
 * `dns.lookup` runs getaddrinfo on the libuv threadpool (4 threads by
 * default) and an abandoned call holds its thread until the system resolver
 * gives up, which can exceed the DNS bound below. Keeping fewer user-host
 * lookups in flight than the pool has threads means slow user hosts can
 * never occupy the whole pool. Deliberately below 4 (the default
 * `UV_THREADPOOL_SIZE`), which this app does not raise.
 *
 * A caller that arrives while the cap is full chooses one of two modes:
 *  - refuse (save routes): rejected immediately with kind `dns_busy`;
 *  - wait (deliveries, `safeFetch`): joins a FIFO queue, and the slot
 *    released to it goes to the head of that queue. The wait counts
 *    against the caller's own DNS budget; a waiter that cannot get a slot
 *    within it rejects with kind `timeout`. A waiter beyond
 *    `MAX_QUEUED_DNS_LOOKUPS` rejects with kind `dns_busy` so an outage
 *    cannot grow the queue without bound.
 *
 * The cap is shared by every user, so a caller may name an owner (alert
 * deliveries name the user whose webhook or Slack target it is). One owner
 * holds at most `MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER` slots at once, which
 * is below the cap: a user whose hosts park their lookups (a resolver that
 * never answers, or just very many webhooks) can never take every slot, so
 * another user's delivery always finds one free unless other users hold the
 * rest. An owner's further callers wait in the same FIFO queue, and a
 * released slot goes to the first waiter whose owner is under its limit,
 * preferring one of a different owner than the lookup that just released
 * it, so a queue full of one user's deliveries does not keep the slot away
 * from the others. A caller without an owner (the save routes) is bound by
 * the global cap only, and its queue position and refusal behave as before.
 */
export const MAX_CONCURRENT_DNS_LOOKUPS = 2;

/**
 * Cap on the lookup slots one owner may hold at once. Must stay below
 * `MAX_CONCURRENT_DNS_LOOKUPS`, or an owner could still take every slot.
 */
export const MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER = 1;

/** Cap on how many deliveries may queue for a lookup slot at once. */
export const MAX_QUEUED_DNS_LOOKUPS = 64;

// The counter and the queue live on globalThis under one shared symbol so
// every copy of this module in the process shares one cap: the production
// build bundles the cron path separately from the app server, and per-copy
// counters would double the real number of lookups against the threadpool.
const DNS_LOOKUP_STATE_KEY = Symbol.for('depsight.safeFetch.dnsLookups');

interface DnsWaiter {
  owner: string | undefined;
  grant: () => void;
  fail: (err: Error) => void;
}

interface DnsLookupState {
  inFlight: number;
  /** Slots held per owner (entries only while above zero); owner-less lookups are not counted. */
  heldByOwner: Map<string, number>;
  queued: DnsWaiter[];
}

function heldBy(state: DnsLookupState, owner: string | undefined): number {
  return owner === undefined ? 0 : (state.heldByOwner.get(owner) ?? 0);
}

function takeOwnerSlot(state: DnsLookupState, owner: string | undefined): void {
  if (owner !== undefined) state.heldByOwner.set(owner, heldBy(state, owner) + 1);
}

function dropOwnerSlot(state: DnsLookupState, owner: string | undefined): void {
  if (owner === undefined) return;
  const left = heldBy(state, owner) - 1;
  if (left > 0) state.heldByOwner.set(owner, left);
  else state.heldByOwner.delete(owner);
}

/** Whether a caller of `owner` may take a slot now, as far as its owner limit goes. */
function ownerHasRoom(state: DnsLookupState, owner: string | undefined): boolean {
  return owner === undefined || heldBy(state, owner) < MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER;
}

/**
 * Remove and return the waiter a freed slot goes to: the first one whose
 * owner is under its limit and differs from the owner that just released,
 * else the first one under its limit (FIFO), else none. Owner-less waiters
 * never count as the releasing owner.
 */
function takeNextWaiter(
  state: DnsLookupState,
  releasedBy: string | undefined,
): DnsWaiter | undefined {
  let firstEligible = -1;
  for (let i = 0; i < state.queued.length; i += 1) {
    const w = state.queued[i];
    if (!ownerHasRoom(state, w.owner)) continue;
    if (firstEligible < 0) firstEligible = i;
    if (releasedBy === undefined || w.owner !== releasedBy) {
      firstEligible = i;
      break;
    }
  }
  if (firstEligible < 0) return undefined;
  return state.queued.splice(firstEligible, 1)[0];
}

function dnsLookupState(): DnsLookupState {
  const g = globalThis as typeof globalThis & {
    [DNS_LOOKUP_STATE_KEY]?: DnsLookupState;
  };
  let state = g[DNS_LOOKUP_STATE_KEY];
  if (!state) {
    state = { inFlight: 0, heldByOwner: new Map(), queued: [] };
    g[DNS_LOOKUP_STATE_KEY] = state;
  }
  return state;
}

/**
 * Join the FIFO wait queue for a lookup slot. Resolves when a release hands
 * the slot to this waiter (the counter is not decremented on a hand-off, the
 * slot moved directly), rejects with kind `timeout` when no slot frees
 * within `timeoutMs`, and rejects with kind `dns_busy` without queueing when
 * the queue is already at its cap.
 */
function waitForDnsSlot(
  state: DnsLookupState,
  timeoutMs: number,
  owner: string | undefined,
): Promise<void> {
  if (state.queued.length >= MAX_QUEUED_DNS_LOOKUPS) {
    return Promise.reject(
      new SafeFetchLimitError(
        'dns_busy',
        `Already ${MAX_QUEUED_DNS_LOOKUPS} host name lookups queued`,
      ),
    );
  }
  let waiter!: DnsWaiter;
  const slot = new Promise<void>((resolve, reject) => {
    waiter = { owner, grant: resolve, fail: reject };
    state.queued.push(waiter);
  });
  const timer = setTimeout(() => {
    // A waiter that ran out of budget leaves the queue, so a later release
    // cannot hand it a slot it no longer wants.
    const at = state.queued.indexOf(waiter);
    if (at >= 0) state.queued.splice(at, 1);
    waiter.fail(
      new SafeFetchLimitError(
        'timeout',
        `No free host name lookup slot within ${timeoutMs} ms`,
      ),
    );
  }, timeoutMs);
  return slot.finally(() => clearTimeout(timer));
}

/** Test helper: the process-wide DNS lookup state, reset to empty. */
export function resetDnsLookupStateForTests(): void {
  const state = dnsLookupState();
  state.inFlight = 0;
  state.heldByOwner = new Map();
  state.queued = [];
}

/** Test helper: lookups currently holding one of the cap's slots. */
export function dnsLookupsInFlightForTests(): number {
  return dnsLookupState().inFlight;
}

/** Test helper: lookup slots currently held by `owner`. */
export function dnsLookupsHeldByOwnerForTests(owner: string): number {
  return heldBy(dnsLookupState(), owner);
}

/** Test helper: waiters currently queued for a slot. */
export function dnsLookupQueueLengthForTests(): number {
  return dnsLookupState().queued.length;
}

/**
 * Validate that `input` is a safe public http(s) URL and return its resolved
 * public IP addresses. Throws SsrfBlockedError on any violation, or
 * SafeFetchLimitError (`timeout` or `dns_busy`) when the host name lookup
 * misses its bound, its wait for a slot misses its budget, or the wait queue
 * is full. `waitForSlot` selects what happens while the cap is full: the
 * save routes pass `false` (refuse at once), `safeFetch` passes `true`
 * (wait in the FIFO queue within the delivery's own budget). `owner` names
 * whose lookup this is and applies the per-owner slot limit (see
 * `MAX_CONCURRENT_DNS_LOOKUPS`); without it only the global cap applies.
 */
export async function assertPublicUrl(
  input: string,
  options?: { dnsTimeoutMs?: number; waitForSlot?: boolean; owner?: string },
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfBlockedError('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Only http(s) URLs are allowed');
  }

  // `new URL('http://[::1]').hostname` returns '[::1]' WITH brackets, but
  // net.isIP('[::1]') returns 0 (unrecognised), so a bracketed IPv6 literal
  // would otherwise skip this synchronous branch and fall through to the
  // DNS-lookup fallback below. Strip one leading '[' and trailing ']' (only
  // when both are present) before the literal-IP check so bracketed IPv6
  // hosts are blocked synchronously, without a DNS lookup, just like any
  // other literal IP.
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  // Literal IP host: validate directly, no DNS needed.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError('URL resolves to a non-public address');
    }
    return { url, addresses: [hostname] };
  }

  // The host is user-controlled, so its resolver may answer slowly. The lookup
  // is raced against a fixed bound and a miss rejects with SafeFetchLimitError.
  //
  // Trade-off, chosen deliberately: dns.lookup (getaddrinfo on the 4-thread
  // libuv pool) is kept instead of a dns.Resolver (c-ares, no pool thread),
  // because getaddrinfo honours /etc/hosts and nsswitch, which a deployment may
  // rely on, and a Resolver would silently change what a hostname resolves to.
  // The cost: the race frees the delivery, not the thread. An abandoned
  // getaddrinfo call keeps its pool slot until the system resolver gives up
  // (resolv.conf timeout and attempts); nothing here cancels it. What the bound
  // guarantees is that no delivery waits on it, or retains anything for it,
  // beyond dnsTimeoutMs. The concurrency cap below bounds how many of those
  // abandoned calls can exist at once, which is what protects the pool.
  //
  // A malformed URL, a non-http(s) scheme or a blocked IP literal has already
  // rejected above, so the cap only ever gates hostname lookups and never
  // masks a synchronous block.
  const dnsTimeoutMs = options?.dnsTimeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const waitForSlot = options?.waitForSlot ?? false;
  const owner = options?.owner;
  const state = dnsLookupState();
  // One budget for the whole host name phase (queue wait plus lookup): for a
  // delivery that is the `timeoutMs` safeFetch passes in, and the request
  // timer there only gets what is left of it.
  const dnsDeadline = Date.now() + dnsTimeoutMs;
  if (state.inFlight < MAX_CONCURRENT_DNS_LOOKUPS && ownerHasRoom(state, owner)) {
    state.inFlight += 1;
    takeOwnerSlot(state, owner);
  } else if (!waitForSlot) {
    throw new SafeFetchLimitError(
      'dns_busy',
      state.inFlight < MAX_CONCURRENT_DNS_LOOKUPS
        ? `Already ${MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER} host name lookups in flight for this owner`
        : `Already ${MAX_CONCURRENT_DNS_LOOKUPS} host name lookups in flight`,
    );
  } else {
    // A release hands its slot straight to a waiter without decrementing the
    // global counter (the owner counts are moved by the release), so when
    // this resolves the slot is already held here.
    await waitForDnsSlot(state, Math.max(1, dnsDeadline - Date.now()), owner);
  }
  let slotHeld = true;
  // Idempotent: whichever settle path reaches it first releases, and a path
  // that already released (the lookup settling on its own) makes the second
  // call a no-op, so the counter cannot drift. A release with waiters hands
  // the slot to the head of the queue instead of freeing it.
  const release = (): void => {
    if (!slotHeld) return;
    slotHeld = false;
    dropOwnerSlot(state, owner);
    const next = takeNextWaiter(state, owner);
    if (next) {
      takeOwnerSlot(state, next.owner);
      next.grant();
    } else {
      state.inFlight -= 1;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  let resolved: string[];
  try {
    const lookupTimeoutMs = Math.max(1, dnsDeadline - Date.now());
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SafeFetchLimitError(
              'timeout',
              `DNS lookup timed out after ${lookupTimeoutMs} ms`,
            ),
          ),
        lookupTimeoutMs,
      );
    });
    const lookup = dns.lookup(hostname, { all: true });
    // Release on the lookup's own settle, not when the race timer fires: the
    // abandoned getaddrinfo call still holds its libuv pool thread until the
    // system resolver gives up, so releasing at the timeout would let slow
    // hosts pile up on the pool anyway. The handlers also consume a late
    // settle, so an already-abandoned lookup cannot cause an unhandled
    // rejection, and a late answer is dropped (nothing dials on it).
    void lookup.then(release, release);
    const records = await Promise.race([lookup, timeout]);
    resolved = records.map((r) => r.address);
  } catch (err) {
    if (err instanceof SafeFetchLimitError) throw err;
    // The lookup itself failed inside the bound (or dns.lookup threw
    // synchronously): it is a resolution failure, not a resource limit.
    release();
    throw new SsrfBlockedError('Could not resolve URL host');
  } finally {
    clearTimeout(timer);
  }

  if (resolved.length === 0) {
    throw new SsrfBlockedError('Could not resolve URL host');
  }

  for (const addr of resolved) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlockedError('URL resolves to a non-public address');
    }
  }

  return { url, addresses: resolved };
}

/**
 * Build a DNS `lookup` callback that only ever resolves to one of the
 * `validated` addresses. This pins the connection to the IP that
 * assertPublicUrl already vetted, defeating DNS-rebinding (TTL=0) where a
 * second by-hostname resolution could return a loopback/metadata address.
 *
 * As defence in depth, the dialed address is re-checked against isBlockedIp
 * so even a poisoned `validated` set fails closed.
 */
export function pinnedLookup(validated: string[]): LookupFunction {
  return ((hostname, options, callback) => {
    // The (hostname, callback) overload passes the callback as `options`.
    const opts = (typeof options === 'function' ? {} : options) ?? {};
    const cb = typeof options === 'function' ? options : callback;

    // Only ever dial addresses assertPublicUrl already vetted, and re-check them
    // against the block list so a poisoned set still fails closed.
    const safe = validated.filter((a) => !isBlockedIp(a));
    if (safe.length === 0) {
      (cb as (err: NodeJS.ErrnoException | null) => void)(
        new SsrfBlockedError('URL resolves to a non-public address'),
      );
      return;
    }

    if ((opts as { all?: boolean }).all) {
      const entries = safe.map((address) => ({ address, family: net.isIP(address) }));
      (cb as (err: null, addresses: { address: string; family: number }[]) => void)(null, entries);
      return;
    }

    const address = safe[0];
    (cb as (err: null, address: string, family: number) => void)(null, address, net.isIP(address));
  }) as LookupFunction;
}

/** Default cap on a response body: webhook and Slack receivers answer with a few bytes. */
export const SAFE_FETCH_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Default total budget (connect, headers and body) for one delivery. */
export const SAFE_FETCH_TIMEOUT_MS = 15_000;

export interface SafeFetchLimits {
  /** Abort the request once the response body exceeds this many bytes. */
  maxResponseBytes?: number;
  /** Abort the request when it has not completed after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Whose delivery this is (an alert delivery passes its user id). Applies
   * the per-owner limit on host name lookup slots, see
   * `MAX_CONCURRENT_DNS_LOOKUPS`; without it only the global cap applies.
   */
  dnsOwner?: string;
}

/** A delivery or URL check stopped by a safeFetch resource limit (response size, total time, or the host name lookup cap and its wait queue). */
export class SafeFetchLimitError extends Error {
  readonly kind: 'response_too_large' | 'timeout' | 'dns_busy';
  constructor(kind: 'response_too_large' | 'timeout' | 'dns_busy', message: string) {
    super(message);
    this.name = 'SafeFetchLimitError';
    this.kind = kind;
  }
}

/** Save-route answer for a URL whose host name lookup missed its bound. */
export const DNS_UNREACHABLE_MESSAGE = 'Host did not resolve in time';

/** Save-route answer for a URL check refused because the lookup cap is full. */
export const DNS_BUSY_MESSAGE = 'Too many host checks in progress, try again';

/**
 * SSRF-safe outbound fetch for user-supplied URLs. Validates the URL, resolves
 * its public IPs once, then dials only those addresses (Host header + TLS SNI
 * preserved). Redirects are disabled so a public host cannot 30x the server
 * into an internal target after the check.
 *
 * The target is user-controlled, so the exchange is bounded: the response body
 * may not exceed `maxResponseBytes` and the whole request (connect, headers,
 * body, plus the DNS lookup before them) may not take longer than
 * `timeoutMs`. Either limit rejects with a SafeFetchLimitError and destroys
 * the socket, so a receiver that streams forever or trickles bytes cannot pin
 * a socket or memory.
 */
export function safeFetch(
  input: string,
  init?: RequestInit,
  limits?: SafeFetchLimits,
): Promise<Response> {
  const maxResponseBytes = limits?.maxResponseBytes ?? SAFE_FETCH_MAX_RESPONSE_BYTES;
  const timeoutMs = limits?.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  // One budget for the whole delivery: the host name phase (a wait for a
  // lookup slot plus the lookup itself; a delivery never gets refused with
  // dns_busy, it waits) counts against `timeoutMs` and the request timer
  // below only gets what is left of it.
  const startedAt = Date.now();
  return assertPublicUrl(input, {
    dnsTimeoutMs: timeoutMs,
    waitForSlot: true,
    owner: limits?.dnsOwner,
  }).then(({ url, addresses }) => {
    const requestTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const transport = url.protocol === 'https:' ? https : http;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      const fail = (err: Error): void => {
        if (!settle()) return;
        req.destroy();
        reject(err);
      };

      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname, // preserves Host header + TLS SNI (servername)
          port,
          path: url.pathname + url.search,
          method,
          headers,
          lookup: pinnedLookup(addresses),
        },
        (res) => {
          const tooLarge = (): SafeFetchLimitError =>
            new SafeFetchLimitError(
              'response_too_large',
              `Response body exceeds ${maxResponseBytes} bytes`,
            );
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxResponseBytes) {
            fail(tooLarge());
            return;
          }
          // A reset mid-body surfaces as an error on the response, not the request.
          res.on('error', fail);
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (c: Buffer) => {
            if (settled) return;
            received += c.length;
            if (received > maxResponseBytes) {
              fail(tooLarge());
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (!settle()) return;
            const status = res.statusCode ?? 0;
            // Disable redirect-following: a 30x is surfaced as-is, never chased
            // into an internal target.
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value == null) continue;
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
            // 101/204/205/304 must have a null body per the Fetch spec.
            const nullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
            resolve(
              new Response(nullBodyStatus ? null : Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      // Armed once the request exists; every settle path clears it.
      const timer = setTimeout(() => {
        fail(new SafeFetchLimitError('timeout', `Request timed out after ${timeoutMs} ms`));
      }, requestTimeoutMs);
      req.on('error', (err) => {
        if (!settle()) return;
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  });
}
