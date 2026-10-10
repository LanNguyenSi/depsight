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

/** Longest textual IP address: a full IPv6 with an embedded IPv4 tail ("0000:...:255.255.255.255"). */
const MAX_ADDRESS_LENGTH = 45;

/**
 * The trusted client address from an X-Forwarded-For value, or null when there
 * is none to trust: no header, `hops` of 0, fewer entries than trusted
 * proxies (the request did not come through the expected chain), or an entry
 * that is not a plain IP address. Longer than 45 characters or carrying an
 * IPv6 zone id (`%eth0`) is not plain: `isIP` accepts a zone id of any length,
 * so without this a caller could put kilobytes into the limiter key.
 *
 * Next.js fills a missing X-Forwarded-For with the socket peer before the
 * handler runs, so "no header" in practice means the entry list is shorter
 * than the trusted hop count, not an absent header.
 */
export function clientIpFromForwardedFor(header: string | null, hops: number): string | null {
  if (!header || hops < 1) return null;
  const entries = header.split(',');
  const index = entries.length - hops;
  if (index < 0) return null;
  const candidate = entries[index].trim();
  if (candidate.length > MAX_ADDRESS_LENGTH || candidate.includes('%')) return null;
  return isIP(candidate) === 0 ? null : candidate.toLowerCase();
}
