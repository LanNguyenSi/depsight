// CIDR matching for IPv4 and IPv6, including the first and last address of a
// range, a prefix that does not fall on a byte boundary, and IPv4-mapped IPv6.
import { describe, it, expect } from 'vitest';
import { cidrContains, parseAddress, parseCidr } from '@/lib/ip-cidr';

function inRange(cidr: string, ip: string): boolean {
  const c = parseCidr(cidr);
  const a = parseAddress(ip);
  if (!c || !a) throw new Error(`unparsable: ${cidr} / ${ip}`);
  return cidrContains(c, a);
}

describe('parseAddress', () => {
  it('parses IPv4 and IPv6 in their compressed and full forms', () => {
    expect(parseAddress('192.30.252.1')).toEqual({
      family: 4,
      bytes: Uint8Array.from([192, 30, 252, 1]),
    });
    expect(parseAddress('::')?.bytes).toEqual(new Uint8Array(16));
    expect(parseAddress('::1')?.bytes[15]).toBe(1);
    expect(parseAddress('1::')?.bytes.slice(0, 2)).toEqual(Uint8Array.from([0, 1]));
    expect(parseAddress('2a0a:a440:0:0:0:0:0:1')?.bytes).toEqual(parseAddress('2a0a:a440::1')?.bytes);
    expect(parseAddress('2A0A:A440::1')?.bytes).toEqual(parseAddress('2a0a:a440::1')?.bytes);
    expect(parseAddress('64:ff9b::1.2.3.4')).toMatchObject({ family: 6 });
    expect(parseAddress('64:ff9b::1.2.3.4')?.bytes.slice(12)).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address it wraps', () => {
    const plain = parseAddress('1.2.3.4');
    expect(parseAddress('::ffff:1.2.3.4')).toEqual(plain);
    expect(parseAddress('::FFFF:1.2.3.4')).toEqual(plain);
    expect(parseAddress('::ffff:0102:0304')).toEqual(plain);
    expect(parseAddress('0:0:0:0:0:ffff:102:304')).toEqual(plain);
    // Other IPv6 addresses that merely look similar stay IPv6.
    expect(parseAddress('::fffe:102:304')?.family).toBe(6);
    expect(parseAddress('1::ffff:102:304')?.family).toBe(6);
  });

  it('rejects text that is not a plain address', () => {
    for (const bad of ['', 'junk', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1::2::3', '::g', 'fe80::1%eth0']) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe('parseCidr', () => {
  it('keeps the address and the prefix length', () => {
    expect(parseCidr('192.30.252.0/22')).toMatchObject({ family: 4, prefix: 22 });
    expect(parseCidr('2a0a:a440::/29')).toMatchObject({ family: 6, prefix: 29 });
    expect(parseCidr('0.0.0.0/0')).toMatchObject({ prefix: 0 });
    expect(parseCidr('1.2.3.4/32')).toMatchObject({ prefix: 32 });
    expect(parseCidr('::1/128')).toMatchObject({ prefix: 128 });
  });

  it('rejects malformed ranges', () => {
    const bad = [
      '',
      '1.2.3.4',
      '1.2.3.4/',
      '/24',
      '1.2.3.4/33',
      '1.2.3.4/-1',
      '1.2.3.4/2x',
      '1.2.3.4/24/8',
      '1.2.3.4/1000',
      'x/8',
      '::/129',
      'fe80::1%eth0/64',
      // A mapped range would need a prefix over 32 once unwrapped; it is not a range GitHub publishes.
      '::ffff:1.2.3.0/120',
    ];
    for (const text of bad) expect(parseCidr(text), text).toBeNull();
  });
});

describe('cidrContains', () => {
  it('includes the first and last address of an IPv4 range and nothing next to it', () => {
    expect(inRange('192.30.252.0/22', '192.30.252.0')).toBe(true);
    expect(inRange('192.30.252.0/22', '192.30.255.255')).toBe(true);
    expect(inRange('192.30.252.0/22', '192.30.253.77')).toBe(true);
    expect(inRange('192.30.252.0/22', '192.30.251.255')).toBe(false);
    expect(inRange('192.30.252.0/22', '192.31.0.0')).toBe(false);
    expect(inRange('192.30.252.0/22', '193.30.252.0')).toBe(false);
  });

  it('handles prefixes that fall inside a byte', () => {
    // /20: 143.55.64.0 - 143.55.79.255
    expect(inRange('143.55.64.0/20', '143.55.79.255')).toBe(true);
    expect(inRange('143.55.64.0/20', '143.55.80.0')).toBe(false);
    expect(inRange('143.55.64.0/20', '143.55.63.255')).toBe(false);
    // /25: one half of the last byte
    expect(inRange('10.0.0.128/25', '10.0.0.255')).toBe(true);
    expect(inRange('10.0.0.128/25', '10.0.0.127')).toBe(false);
    // /31 and /32
    expect(inRange('10.0.0.6/31', '10.0.0.7')).toBe(true);
    expect(inRange('10.0.0.6/31', '10.0.0.8')).toBe(false);
    expect(inRange('10.0.0.6/32', '10.0.0.6')).toBe(true);
    expect(inRange('10.0.0.6/32', '10.0.0.7')).toBe(false);
  });

  it('compares only the network part, so host bits of the range address are ignored', () => {
    expect(inRange('192.30.253.99/22', '192.30.252.1')).toBe(true);
  });

  it('matches everything of the family for a prefix of 0 and nothing of the other family', () => {
    expect(inRange('0.0.0.0/0', '203.0.113.9')).toBe(true);
    expect(inRange('0.0.0.0/0', '2001:db8::1')).toBe(false);
    expect(inRange('::/0', '2001:db8::1')).toBe(true);
    expect(inRange('::/0', '203.0.113.9')).toBe(false);
  });

  it('includes the first and last address of an IPv6 range and nothing next to it', () => {
    // /29: 2a0a:a440:: - 2a0a:a447:ffff:ffff:ffff:ffff:ffff:ffff
    expect(inRange('2a0a:a440::/29', '2a0a:a440::')).toBe(true);
    expect(inRange('2a0a:a440::/29', '2a0a:a447:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(inRange('2a0a:a440::/29', '2a0a:a448::')).toBe(false);
    expect(inRange('2a0a:a440::/29', '2a0a:a43f:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(false);
    expect(inRange('2606:50c0::/32', '2606:50c0:ffff::1')).toBe(true);
    expect(inRange('2606:50c0::/32', '2606:50c1::')).toBe(false);
    expect(inRange('2001:db8::1/128', '2001:db8::1')).toBe(true);
    expect(inRange('2001:db8::1/128', '2001:db8::2')).toBe(false);
  });

  it('does not match across families', () => {
    expect(inRange('192.30.252.0/22', '2a0a:a440::1')).toBe(false);
    expect(inRange('2a0a:a440::/29', '192.30.252.1')).toBe(false);
  });

  it('matches an IPv4-mapped IPv6 address against IPv4 ranges only', () => {
    expect(inRange('192.30.252.0/22', '::ffff:192.30.252.1')).toBe(true);
    expect(inRange('192.30.252.0/22', '::ffff:c01e:fc01')).toBe(true);
    expect(inRange('192.30.252.0/22', '::ffff:192.30.255.255')).toBe(true);
    expect(inRange('192.30.252.0/22', '::ffff:192.30.251.255')).toBe(false);
    expect(inRange('192.30.252.0/22', '::ffff:192.31.0.0')).toBe(false);
    // Mapped zero address is the IPv4 zero address, not an IPv6 one.
    expect(inRange('::/0', '::ffff:1.2.3.4')).toBe(false);
  });
});
