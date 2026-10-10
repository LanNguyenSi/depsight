// Unit tests for the trusted-proxy client address helper.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clientIpFromForwardedFor,
  trustedProxyHops,
  DEFAULT_TRUSTED_PROXY_HOPS,
} from '@/lib/client-ip';

describe('clientIpFromForwardedFor', () => {
  it('returns the last entry for one trusted hop', () => {
    expect(clientIpFromForwardedFor('203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientIpFromForwardedFor('6.6.6.6, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientIpFromForwardedFor('6.6.6.6,7.7.7.7,203.0.113.9', 1)).toBe('203.0.113.9');
  });

  it('counts from the right for several trusted hops', () => {
    expect(clientIpFromForwardedFor('6.6.6.6, 203.0.113.9, 10.0.0.2', 2)).toBe('203.0.113.9');
    expect(clientIpFromForwardedFor('203.0.113.9, 10.0.0.2, 10.0.0.3', 3)).toBe('203.0.113.9');
  });

  it('is null when there is nothing to trust', () => {
    expect(clientIpFromForwardedFor(null, 1)).toBeNull();
    expect(clientIpFromForwardedFor('', 1)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9', 0)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9', 2)).toBeNull();
  });

  it('is null when the trusted entry is not an address', () => {
    expect(clientIpFromForwardedFor('203.0.113.9, not-an-ip', 1)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9, ', 1)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9:443', 1)).toBeNull();
    expect(clientIpFromForwardedFor('x'.repeat(5000), 1)).toBeNull();
  });

  it('accepts IPv6 and normalises its case', () => {
    expect(clientIpFromForwardedFor('2001:DB8::1', 1)).toBe('2001:db8::1');
  });
});

describe('trustedProxyHops', () => {
  afterEach(() => {
    delete process.env.WEBHOOK_TRUSTED_PROXY_HOPS;
    vi.restoreAllMocks();
  });

  it('defaults to one hop when unset or blank', () => {
    expect(trustedProxyHops()).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '  ';
    expect(trustedProxyHops()).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
  });

  it('reads a whole number from 0 to 8', () => {
    process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '0';
    expect(trustedProxyHops()).toBe(0);
    process.env.WEBHOOK_TRUSTED_PROXY_HOPS = ' 3 ';
    expect(trustedProxyHops()).toBe(3);
    process.env.WEBHOOK_TRUSTED_PROXY_HOPS = '8';
    expect(trustedProxyHops()).toBe(8);
  });

  it('falls back to the default for anything else', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const bad of ['9', '-1', '1.5', 'two', '1e1']) {
      process.env.WEBHOOK_TRUSTED_PROXY_HOPS = bad;
      expect(trustedProxyHops()).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    }
  });
});
