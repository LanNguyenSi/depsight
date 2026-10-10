import { isIP } from 'node:net';

/**
 * A small CIDR matcher for IPv4 and IPv6, with no dependency. An IPv4-mapped
 * IPv6 address (`::ffff:1.2.3.4` or `::ffff:102:304`) is the IPv4 address it
 * wraps, so it matches IPv4 ranges and never an IPv6 range.
 */

export interface ParsedAddress {
  family: 4 | 6;
  /** 4 bytes for IPv4, 16 for IPv6. */
  bytes: Uint8Array;
}

export interface Cidr extends ParsedAddress {
  /** Number of leading bits that must match (0 to 32, or 0 to 128). */
  prefix: number;
}

const DECIMAL = /^\d{1,3}$/;

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!DECIMAL.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | null {
  let s = text.toLowerCase();
  // An embedded IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

/** True for ::ffff:0:0/96, the IPv4-mapped IPv6 block. */
function isMapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Parse a plain IP address (a zone id such as `%eth0` is not accepted), or
 * null. An IPv4-mapped IPv6 address comes back as the IPv4 address it wraps.
 */
export function parseAddress(text: string): ParsedAddress | null {
  if (text.includes('%')) return null;
  const family = isIP(text);
  if (family === 4) {
    const bytes = parseIpv4(text);
    return bytes ? { family: 4, bytes } : null;
  }
  if (family === 6) {
    const bytes = parseIpv6(text);
    if (!bytes) return null;
    return isMapped(bytes) ? { family: 4, bytes: bytes.slice(12) } : { family: 6, bytes };
  }
  return null;
}

/** Parse "address/prefix", or null when either part is not valid for its family. */
export function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  const prefixText = text.slice(slash + 1);
  if (!DECIMAL.test(prefixText)) return null;
  const address = parseAddress(text.slice(0, slash));
  if (!address) return null;
  const prefix = Number(prefixText);
  if (prefix > address.bytes.length * 8) return null;
  return { ...address, prefix };
}

/** Whether `address` lies inside `cidr`; addresses of different families never match. */
export function cidrContains(cidr: Cidr, address: ParsedAddress): boolean {
  if (cidr.family !== address.family) return false;
  const wholeBytes = cidr.prefix >> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (cidr.bytes[i] !== address.bytes[i]) return false;
  }
  const restBits = cidr.prefix & 7;
  if (restBits === 0) return true;
  const mask = (0xff << (8 - restBits)) & 0xff;
  return (cidr.bytes[wholeBytes] & mask) === (address.bytes[wholeBytes] & mask);
}
