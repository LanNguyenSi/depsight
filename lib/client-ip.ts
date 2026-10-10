import { isIP } from 'node:net';

/**
 * Client address for the unauthenticated PR-scan webhook, from X-Forwarded-For.
 *
 * Node gives a route handler no socket address, so the only source is the
 * header of the reverse proxy in front of the app. Each proxy appends the
 * address it received the request from, so the entry that can be trusted is
 * counted from the RIGHT: with N trusted proxies the Nth entry from the right
 * is the address the outermost trusted proxy saw. Everything left of it is
 * whatever the caller (or an untrusted hop) wrote and is never used. The
 * production deployment has one proxy (traefik, which is also the only way to
 * reach the app), so the default is 1.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
const MAX_TRUSTED_PROXY_HOPS = 8;

let warnedInvalidHops = false;

/**
 * Number of trusted proxies in front of the app (WEBHOOK_TRUSTED_PROXY_HOPS).
 * 0 means the header is not trusted at all and every caller shares one bucket.
 * Unset or blank means the default; any other value that is not a whole number
 * from 0 to 8 falls back to the default with a one-time warning rather than
 * silently trusting or ignoring the header.
 */
export function trustedProxyHops(): number {
  const raw = process.env.WEBHOOK_TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return DEFAULT_TRUSTED_PROXY_HOPS;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n <= MAX_TRUSTED_PROXY_HOPS) return n;
  }
  if (!warnedInvalidHops) {
    warnedInvalidHops = true;
    console.warn(
      `WEBHOOK_TRUSTED_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS}; using ${DEFAULT_TRUSTED_PROXY_HOPS}`,
    );
  }
  return DEFAULT_TRUSTED_PROXY_HOPS;
}

/**
 * The trusted client address from an X-Forwarded-For value, or null when there
 * is none to trust: no header, `hops` of 0, fewer entries than trusted
 * proxies (the request did not come through the expected chain), or an entry
 * that is not an IP address (so a caller cannot put an arbitrary string, or a
 * huge one, into the limiter key).
 */
export function clientIpFromForwardedFor(header: string | null, hops: number): string | null {
  if (!header || hops < 1) return null;
  const entries = header.split(',');
  const index = entries.length - hops;
  if (index < 0) return null;
  const candidate = entries[index].trim();
  return isIP(candidate) === 0 ? null : candidate.toLowerCase();
}
