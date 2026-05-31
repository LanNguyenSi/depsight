import dns from 'dns/promises';
import net from 'net';

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

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — evaluate the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
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
 * Validate that `input` is a safe public http(s) URL and return its resolved
 * public IP addresses. Throws SsrfBlockedError on any violation.
 */
export async function assertPublicUrl(input: string): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfBlockedError('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Only http(s) URLs are allowed');
  }

  const hostname = url.hostname;

  // Literal IP host: validate directly, no DNS needed.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError('URL resolves to a non-public address');
    }
    return { url, addresses: [hostname] };
  }

  let resolved: string[];
  try {
    const records = await dns.lookup(hostname, { all: true });
    resolved = records.map((r) => r.address);
  } catch {
    throw new SsrfBlockedError('Could not resolve URL host');
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
 * SSRF-safe outbound fetch for user-supplied URLs. Validates the URL, then
 * issues the request. Redirects are disabled so a public host cannot 30x the
 * server into an internal target after the check.
 */
export async function safeFetch(input: string, init?: RequestInit): Promise<Response> {
  await assertPublicUrl(input);
  return fetch(input, { ...init, redirect: 'error' });
}
