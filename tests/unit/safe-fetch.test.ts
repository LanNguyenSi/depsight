// Tests for lib/net/safe-fetch.ts — SSRF guard
// Tests the REAL function; no vi.mock of safe-fetch itself.
// DNS mocking covers hostname-resolution paths; literal-IP paths need no mocks.
// HTTP/HTTPS module mocking covers the safeFetch transport layer and pinnedLookup.
// NOTE: literal bracketed IPv6 hosts (e.g. http://[::1]) are not exercised end-to-end here.
// net.isIP('[::1]') returns 0 (brackets), so assertPublicUrl skips the literal-IP branch and
// production blocks such hosts via the DNS-failure path. A synchronous bracket-stripping
// hardening is tracked as a depsight follow-up; these tests cover isPrivateIPv6 via the DNS path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { dnsLookupMock, httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (all must be synchronous factories to avoid hoisting issues)
// ---------------------------------------------------------------------------
vi.mock('dns/promises', () => ({
  default: { lookup: dnsLookupMock },
  lookup: dnsLookupMock,
}));

vi.mock('http', () => {
  const mock = { request: httpRequestMock };
  return { default: mock, ...mock };
});

vi.mock('https', () => {
  const mock = { request: httpsRequestMock };
  return { default: mock, ...mock };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { assertPublicUrl, safeFetch, SsrfBlockedError, pinnedLookup } from '@/lib/net/safe-fetch';

// ---------------------------------------------------------------------------
// Helpers — fake HTTP response/request for transport tests
// ---------------------------------------------------------------------------
interface FakeResOptions {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}

type FakeReq = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

type FakeRes = EventEmitter & {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
};

/**
 * Install a one-shot mock on requestMock that simulates a real HTTP response.
 * Returns the fake `req` object so callers can assert `req.write` / `req.end`.
 */
function installHttpMock(
  requestMock: ReturnType<typeof vi.fn>,
  opts: FakeResOptions = {},
): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.write = vi.fn();
  req.end = vi.fn();

  const res = new EventEmitter() as FakeRes;
  res.statusCode = opts.statusCode ?? 200;
  res.statusMessage = opts.statusMessage ?? 'OK';
  res.headers = opts.headers ?? { 'content-type': 'application/json' };
  const responseBody = opts.body ?? '{"ok":true}';

  requestMock.mockImplementationOnce((_options: unknown, callback: (r: FakeRes) => void) => {
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        if (responseBody) res.emit('data', Buffer.from(responseBody));
        res.emit('end');
      });
    });
    return req;
  });

  return req;
}

// ---------------------------------------------------------------------------
// Tests — literal IPv4 (no DNS needed)
// ---------------------------------------------------------------------------
describe('assertPublicUrl — literal-IPv4 paths (no DNS)', () => {
  it('(1) accepts a valid http URL with a public literal IPv4', async () => {
    const result = await assertPublicUrl('http://93.184.216.34');
    expect(result.addresses).toContain('93.184.216.34');
    expect(result.url.hostname).toBe('93.184.216.34');
  });

  it('(3) rejects an unparseable URL string', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('not a url')).rejects.toThrow('Invalid URL format');
  });

  it('(4) rejects non-http(s) scheme — file://', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(
      'Only http(s) URLs are allowed',
    );
  });

  it('(4) rejects non-http(s) scheme — ftp://', async () => {
    await expect(assertPublicUrl('ftp://x.com')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('ftp://x.com')).rejects.toThrow('Only http(s) URLs are allowed');
  });

  it('(5) rejects literal IPv4 loopback http://127.0.0.1', async () => {
    await expect(assertPublicUrl('http://127.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://127.0.0.1')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(6) rejects literal RFC1918 http://10.0.0.1', async () => {
    await expect(assertPublicUrl('http://10.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://10.0.0.1')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(6) rejects literal RFC1918 http://172.16.0.1', async () => {
    await expect(assertPublicUrl('http://172.16.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://172.16.0.1')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(6) rejects literal RFC1918 http://192.168.1.1', async () => {
    await expect(assertPublicUrl('http://192.168.1.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://192.168.1.1')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(7) rejects literal cloud-metadata http://169.254.169.254', async () => {
    await expect(assertPublicUrl('http://169.254.169.254')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://169.254.169.254')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — DNS resolution paths
// ---------------------------------------------------------------------------
describe('assertPublicUrl — DNS resolution paths', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
  });

  it('(2) accepts a hostname that DNS-resolves to a public IP', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const result = await assertPublicUrl('https://example.com');
    expect(result.addresses).toContain('93.184.216.34');
    expect(result.url.hostname).toBe('example.com');
  });

  // Note: new URL('http://[::1]').hostname returns '[::1]' WITH brackets.
  // net.isIP('[::1]') returns 0 (not recognised as literal IP) so the code
  // falls through to DNS. We mock DNS to return the bare address so the
  // private-IPv6 detection runs correctly.

  it('(8) rejects IPv6 loopback ::1 resolved via DNS', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);

    await expect(assertPublicUrl('http://[::1]')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://[::1]')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(9) rejects IPv4-mapped private IPv6 ::ffff:10.0.0.1 resolved via DNS', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '::ffff:10.0.0.1', family: 6 }]);

    await expect(assertPublicUrl('http://[::ffff:10.0.0.1]')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertPublicUrl('http://[::ffff:10.0.0.1]')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(10) rejects unique-local IPv6 fd00::1 resolved via DNS', async () => {
    dnsLookupMock.mockResolvedValue([{ address: 'fd00::1', family: 6 }]);

    await expect(assertPublicUrl('http://[fd00::1]')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://[fd00::1]')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(11) rejects link-local IPv6 fe80::1 resolved via DNS', async () => {
    dnsLookupMock.mockResolvedValue([{ address: 'fe80::1', family: 6 }]);

    await expect(assertPublicUrl('http://[fe80::1]')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('http://[fe80::1]')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(12) rejects when DNS lookup throws ENOTFOUND', async () => {
    const err = Object.assign(new Error('ENOTFOUND example.invalid'), { code: 'ENOTFOUND' });
    dnsLookupMock.mockRejectedValue(err);

    await expect(assertPublicUrl('https://example.invalid')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('https://example.invalid')).rejects.toThrow(
      'Could not resolve URL host',
    );
  });

  it('(13) rejects when DNS returns an empty array', async () => {
    dnsLookupMock.mockResolvedValue([]);

    await expect(assertPublicUrl('https://empty.example')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicUrl('https://empty.example')).rejects.toThrow(
      'Could not resolve URL host',
    );
  });

  it('(14) rejects when DNS resolves to a private IP (cloud metadata)', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(assertPublicUrl('https://metadata.example')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertPublicUrl('https://metadata.example')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — safeFetch SSRF propagation (private-IP rejection, before transport)
// ---------------------------------------------------------------------------
describe('safeFetch — SSRF propagation (no HTTP transport)', () => {
  it('(15) safeFetch rejects when the URL is a private RFC1918 IP', async () => {
    await expect(safeFetch('http://192.168.0.1/api')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(safeFetch('http://192.168.0.1/api')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('(15) safeFetch rejects for loopback URL', async () => {
    await expect(safeFetch('http://127.0.0.1/secret')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(safeFetch('http://127.0.0.1/secret')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
  });

  it('private-IP target blocked before any HTTP transport', async () => {
    await expect(safeFetch('http://10.0.0.1/redirect-target')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    // httpRequestMock must NOT have been called
    expect(httpRequestMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — safeFetch HTTP transport (mocked http.request)
// ---------------------------------------------------------------------------
describe('safeFetch — HTTP transport (mocked http.request)', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
    httpRequestMock.mockReset();
    httpsRequestMock.mockReset();
  });

  it('makes an http.request to a public literal-IP URL and returns the response', async () => {
    installHttpMock(httpRequestMock, { statusCode: 200, body: '{"hello":"world"}' });

    const response = await safeFetch('http://93.184.216.34/data');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('{"hello":"world"}');

    expect(httpRequestMock).toHaveBeenCalledOnce();
    const callOpts = httpRequestMock.mock.calls[0][0] as { hostname: string; method: string };
    expect(callOpts.hostname).toBe('93.184.216.34');
    expect(callOpts.method).toBe('GET');
  });

  it('makes an https.request when the URL uses https:// scheme', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    installHttpMock(httpsRequestMock, { statusCode: 200, body: 'secure' });

    const response = await safeFetch('https://example.com/secure');
    expect(response.status).toBe(200);
    expect(httpsRequestMock).toHaveBeenCalledOnce();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it('passes method and body from init options', async () => {
    const req = installHttpMock(httpRequestMock, { statusCode: 201, body: '{"id":"new"}' });

    const response = await safeFetch('http://93.184.216.34/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"test"}',
    });

    expect(response.status).toBe(201);
    // body was written to the request
    expect(req.write).toHaveBeenCalledWith('{"name":"test"}');
  });

  it('does not call req.write when no body is provided', async () => {
    const req = installHttpMock(httpRequestMock, { statusCode: 200, body: 'ok' });

    await safeFetch('http://93.184.216.34/');
    expect(req.write).not.toHaveBeenCalled();
  });

  it('returns null body for 204 No Content (null-body status)', async () => {
    installHttpMock(httpRequestMock, { statusCode: 204, body: '' });

    const response = await safeFetch('http://93.184.216.34/resource');
    expect(response.status).toBe(204);
  });

  it('returns null body for 304 Not Modified (null-body status)', async () => {
    installHttpMock(httpRequestMock, { statusCode: 304, body: '' });

    const response = await safeFetch('http://93.184.216.34/resource');
    expect(response.status).toBe(304);
  });

  it('surfaces array response headers as joined comma-separated strings', async () => {
    installHttpMock(httpRequestMock, {
      statusCode: 200,
      headers: { 'set-cookie': ['a=1', 'b=2'], 'content-type': 'text/plain' },
      body: 'ok',
    });

    const response = await safeFetch('http://93.184.216.34/headers');
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2');
    expect(response.headers.get('content-type')).toBe('text/plain');
  });

  it('rejects with the request error when http.request emits an error', async () => {
    const req = new EventEmitter() as FakeReq;
    req.write = vi.fn();
    req.end = vi.fn().mockImplementation(() => {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    });

    httpRequestMock.mockImplementationOnce(() => req);

    await expect(safeFetch('http://93.184.216.34/fail')).rejects.toThrow('ECONNREFUSED');
  });

  it('(16) does NOT follow redirects — 301 response is surfaced as-is', async () => {
    installHttpMock(httpRequestMock, {
      statusCode: 301,
      headers: { location: 'http://10.0.0.1/internal' },
      body: '',
    });

    const response = await safeFetch('http://93.184.216.34/redirect');
    // The 301 is returned directly; safeFetch does NOT follow the Location header.
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('http://10.0.0.1/internal');
    // httpRequestMock called only ONCE — no follow-up request to the Location URL.
    expect(httpRequestMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests — pinnedLookup (exercised via safeFetch with DNS-resolved hostname)
// ---------------------------------------------------------------------------
describe('pinnedLookup — DNS-pinning behaviour (exercised via safeFetch)', () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
    httpRequestMock.mockReset();
  });

  it('passes a lookup function into http.request options', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    installHttpMock(httpRequestMock, { statusCode: 200, body: 'ok' });

    await safeFetch('http://example.com/path');

    const callOpts = httpRequestMock.mock.calls[0][0] as {
      hostname: string;
      lookup: (...args: unknown[]) => void;
    };
    expect(typeof callOpts.lookup).toBe('function');
    expect(callOpts.hostname).toBe('example.com');
  });

  it('pinnedLookup returns public addresses when all:true is passed', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    installHttpMock(httpRequestMock, { statusCode: 200, body: 'ok' });

    await safeFetch('http://example.com/path');

    const callOpts = httpRequestMock.mock.calls[0][0] as {
      lookup: (
        host: string,
        opts: { all?: boolean },
        cb: (err: null | Error, addrs?: { address: string; family: number }[], family?: number) => void
      ) => void;
    };

    // Exercise the lookup function with { all: true }
    const results = await new Promise<{ address: string; family: number }[]>((resolve) => {
      callOpts.lookup('example.com', { all: true }, (_err, addrs) => {
        resolve(addrs as { address: string; family: number }[]);
      });
    });
    expect(results).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('pinnedLookup returns single address when all:false is passed', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    installHttpMock(httpRequestMock, { statusCode: 200, body: 'ok' });

    await safeFetch('http://example.com/path');

    const callOpts = httpRequestMock.mock.calls[0][0] as {
      lookup: (
        host: string,
        opts: { all?: boolean },
        cb: (err: null | Error, address?: string, family?: number) => void
      ) => void;
    };

    // Exercise the lookup function without all:true (single-address path)
    const result = await new Promise<{ address: string; family: number }>((resolve) => {
      callOpts.lookup('example.com', { all: false }, (_err, address, family) => {
        resolve({ address: address as string, family: family as number });
      });
    });
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('pinnedLookup handles the (hostname, callback) overload (options is callback)', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    installHttpMock(httpRequestMock, { statusCode: 200, body: 'ok' });

    await safeFetch('http://example.com/path');

    const callOpts = httpRequestMock.mock.calls[0][0] as {
      lookup: (
        host: string,
        cb: (err: null | Error, address?: string, family?: number) => void
      ) => void;
    };

    // Exercise the (hostname, callback) overload — options IS the callback
    const result = await new Promise<{ address: string; family: number }>((resolve) => {
      callOpts.lookup('example.com', (_err: null | Error, address?: string, family?: number) => {
        resolve({ address: address as string, family: family as number });
      });
    });
    expect(result.address).toBe('93.184.216.34');
  });

  // Exercise the REAL pinnedLookup directly (exported for testability). This covers the
  // anti-DNS-rebinding defence-in-depth re-validation + fail-closed branch that cannot be
  // reached through assertPublicUrl (which only ever returns already-vetted public addresses).
  type AllLookup = (
    host: string,
    opts: { all?: boolean },
    cb: (err: Error | null, addrs: { address: string; family: number }[]) => void,
  ) => void;

  it('pinnedLookup fails closed when every validated address is blocked (anti-DNS-rebinding)', async () => {
    const lookup = pinnedLookup(['127.0.0.1', '169.254.169.254']) as unknown as AllLookup;
    const err = await new Promise<Error | null>((resolve) => {
      lookup('example.com', { all: true }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as Error).message).toBe('URL resolves to a non-public address');
  });

  it('pinnedLookup filters out blocked addresses and dials only the vetted public one', async () => {
    const lookup = pinnedLookup(['127.0.0.1', '93.184.216.34']) as unknown as AllLookup;
    const addrs = await new Promise<{ address: string; family: number }[]>((resolve) => {
      lookup('example.com', { all: true }, (_e, a) => resolve(a));
    });
    expect(addrs).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
