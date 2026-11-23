// IPv6 address judgement in lib/net/safe-fetch.ts.
//
// The block list decides on the parsed value of an IPv6 address, never on a
// string prefix, so a canonical and a non-canonical spelling of one address
// get the same verdict. `new URL(...)` canonicalizes a bracketed IPv6 host
// (`http://[0:0:0:0:0:0:7f00:1]` arrives as `[::7f00:1]`), so the non-canonical
// spellings are also run through the DNS-answer path and the pinned lookup,
// which hand the validator the resolver's string unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dnsLookupMock, httpRequestMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpRequestMock: vi.fn(),
}));

vi.mock('dns/promises', () => ({
  default: { lookup: dnsLookupMock },
  lookup: dnsLookupMock,
}));

vi.mock('http', () => {
  const mock = { request: httpRequestMock };
  return { default: mock, ...mock };
});

import { assertPublicUrl, pinnedLookup, SsrfBlockedError } from '@/lib/net/safe-fetch';

/** Every spelling below is judged by its value, so both forms must agree. */
const BLOCKED: { label: string; address: string }[] = [
  { label: 'IPv4-compatible loopback spelling of 127.0.0.1', address: '::127.0.0.1' },
  { label: 'same address in hex words', address: '::7f00:1' },
  { label: 'IPv4-compatible link-local spelling of 169.254.169.254', address: '::a9fe:a9fe' },
  { label: 'IPv4-compatible form of a public IPv4 (::/96 is blocked whole)', address: '::8.8.8.8' },
  { label: '6to4 carrying 127.0.0.1', address: '2002:7f00:1::' },
  { label: '6to4 carrying 8.8.8.8 (the whole /16 is blocked)', address: '2002:0808:0808::' },
  { label: 'Teredo (2001:0000::/32)', address: '2001:0:4136:e378::' },
  { label: 'Teredo, compressed (no `2001:0:` prefix to match)', address: '2001::' },
  {
    label: 'Teredo, zero-padded words (no `2001:0:` prefix to match)',
    address: '2001:0000:4136:e378::',
  },
  { label: 'IPv4-mapped loopback, no compression', address: '0:0:0:0:0:ffff:7f00:1' },
  { label: 'IPv4-compatible loopback, no compression', address: '0:0:0:0:0:0:7f00:1' },
  { label: 'the unspecified address', address: '::' },
  { label: 'loopback', address: '::1' },
  { label: 'unique local', address: 'fd00::1' },
  { label: 'link-local', address: 'fe80::1' },
  { label: 'IPv4-mapped RFC1918', address: '::ffff:10.0.0.1' },
  { label: 'IPv4-mapped link-local metadata', address: '::ffff:169.254.169.254' },
  {
    label: 'IPv4-mapped RFC1918, asymmetric octet pairs (catches a word-6 byte swap)',
    address: '::ffff:192.168.1.1',
  },
  {
    label: 'IPv4-mapped RFC1918 in hex words (catches a word-6 byte swap)',
    address: '::ffff:c0a8:101',
  },
  {
    label: 'IPv4-mapped RFC1918, swapped bytes fall out of range (catches a word-6 swap)',
    address: '::ffff:172.16.0.1',
  },
  {
    label: 'IPv4-mapped IETF protocol assignment, word 7 asymmetric (catches a word-7 byte swap)',
    address: '::ffff:192.0.0.9',
  },
  { label: 'link-local within /10 but above the /12 floor', address: 'fe90::1' },
  { label: 'link-local at the top of /10 (febf is still fe80::/10)', address: 'febf::1' },
  { label: 'unique local at the /7 floor', address: 'fc00::1' },
];

/** Unchanged verdicts: these stay allowed. */
const ALLOWED: { label: string; address: string }[] = [
  { label: 'IPv4-mapped public IPv4', address: '::ffff:8.8.8.8' },
  { label: 'IPv4-mapped public IPv4 in hex words', address: '::ffff:0808:0808' },
  {
    label: 'IPv4-mapped public IPv4, a word swap would land it in 10/8',
    address: '::ffff:1.1.10.0',
  },
  {
    label: 'IPv4-mapped public IPv4 in hex words (same address)',
    address: '::ffff:0101:0a00',
  },
  { label: 'just below fc00::/7 (edge control for the unique-local mask)', address: 'fbff::1' },
  {
    label: 'just below fe80::/10 (edge control for the link-local mask)',
    address: 'fe00::1',
  },
  { label: 'Google DNS (inside 2001:: but not 2001:0000::/32)', address: '2001:4860:4860::8888' },
  { label: 'documentation prefix, not Teredo', address: '2001:db8::1' },
  { label: 'Google DNS prefix, not Teredo', address: '2001:4860::1' },
  { label: 'ordinary global address', address: '2606:4700:4700::1111' },
];

describe('isPrivateIPv6 — bracketed IPv6 literals (synchronous, no DNS)', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
  });

  it.each(BLOCKED)('blocks $label ($address)', async ({ address }) => {
    await expect(assertPublicUrl(`http://[${address}]`)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl(`http://[${address}]`)).rejects.toThrow(
      'URL resolves to a non-public address',
    );
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it.each(ALLOWED)('allows $label ($address)', async ({ address }) => {
    const result = await assertPublicUrl(`http://[${address}]`);
    expect(result.addresses.length).toBe(1);
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });
});

describe('isPrivateIPv6 — DNS answers (the resolver string is judged as given)', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
  });

  it.each(BLOCKED)('blocks a $label answer ($address)', async ({ address }) => {
    dnsLookupMock.mockResolvedValue([{ address, family: 6 }]);
    await expect(assertPublicUrl('https://host.example')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('https://host.example')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it.each(ALLOWED)('allows a $label answer ($address)', async ({ address }) => {
    dnsLookupMock.mockResolvedValue([{ address, family: 6 }]);
    const result = await assertPublicUrl('https://host.example');
    expect(result.addresses).toEqual([address]);
  });

  it('blocks an answer carrying a zone id, which cannot be judged at all', async () => {
    // net.isIP accepts a scoped address; the parser refuses it, so the verdict
    // comes from the fail-closed branch, not from the range list. A public
    // base address does not make it dialable: the zone only means something
    // on the resolving host.
    dnsLookupMock.mockResolvedValue([{ address: '2001:4860::1%eth0', family: 6 }]);
    await expect(assertPublicUrl('https://scoped.example')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    dnsLookupMock.mockResolvedValue([{ address: 'fe80::1%eth0', family: 6 }]);
    await expect(assertPublicUrl('https://scoped.example')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('blocks a public address when one answer of the set is blocked', async () => {
    dnsLookupMock.mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '2002:7f00:1::', family: 6 },
    ]);
    await expect(assertPublicUrl('https://dual.example')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

// The pinned lookup re-checks every address it was handed, so this is the
// second place a non-canonical IPv6 spelling can arrive (a `validated` set
// built by anything other than assertPublicUrl must still fail closed).
describe('pinnedLookup — IPv6 re-check of the validated set', () => {
  type AllLookup = (
    host: string,
    opts: { all?: boolean },
    cb: (err: Error | null, addrs?: { address: string; family: number }[], family?: number) => void,
  ) => void;

  function look(validated: string[], host = 'host.example') {
    const lookup = pinnedLookup(validated) as unknown as AllLookup;
    return new Promise<{ err: Error | null; addrs: { address: string; family: number }[] }>(
      (resolve) => {
        lookup(host, { all: true }, (err, addrs) => resolve({ err, addrs: addrs ?? [] }));
      },
    );
  }

  it.each([
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['0:0:0:0:0:0:7f00:1', 'the same address without compression'],
    ['2002:0808:0808::', '6to4'],
    ['2001:0:4136:e378::', 'Teredo'],
    ['2001:4860::1%eth0', 'an unparseable scoped address'],
  ])('fails closed on an all-blocked set holding %s (%s)', async (address) => {
    const { err, addrs } = await look([address]);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(err?.message).toBe('URL resolves to a non-public address');
    expect(addrs).toEqual([]);
  });

  it('dials only the public address of a mixed IPv6 set', async () => {
    const { err, addrs } = await look(['0:0:0:0:0:ffff:7f00:1', '2002:7f00:1::', '2001:4860::1']);
    expect(err).toBeNull();
    expect(addrs).toEqual([{ address: '2001:4860::1', family: 6 }]);
  });

  it('keeps an allowed IPv4-mapped address in the dialed set', async () => {
    const { err, addrs } = await look(['::ffff:8.8.8.8', '::ffff:10.0.0.1']);
    expect(err).toBeNull();
    expect(addrs).toEqual([{ address: '::ffff:8.8.8.8', family: 6 }]);
  });
});
