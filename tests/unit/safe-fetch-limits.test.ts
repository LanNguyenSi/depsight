// safeFetch resource limits (response size cap, total timeout) against a real
// local HTTP server.
//
// safeFetch refuses loopback targets, and that guard is not touched here. The
// URLs below use a literal public address, so assertPublicUrl and pinnedLookup
// run exactly as in production; only the `http` transport is wrapped so that
// the final socket dial goes to the local test server instead of the public
// address. The wrapper replaces nothing but the destination of the connection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { Socket } from 'net';

const target = vi.hoisted(() => ({ port: 0 }));

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  const request = ((options: import('http').RequestOptions, cb?: (res: IncomingMessage) => void) =>
    actual.request(
      { ...options, hostname: '127.0.0.1', port: target.port, lookup: undefined },
      cb,
    )) as typeof actual.request;
  return { ...actual, request, default: { ...actual, request } };
});

import http from 'http';
import {
  safeFetch,
  SafeFetchLimitError,
  SAFE_FETCH_MAX_RESPONSE_BYTES,
  SAFE_FETCH_TIMEOUT_MS,
} from '@/lib/net/safe-fetch';

const URL_UNDER_TEST = 'http://93.184.216.34/hook';

let server: Server;
let sockets: Socket[];
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeEach(async () => {
  sockets = [];
  handler = (_req, res) => res.end('ok');
  server = http.createServer((req, res) => handler(req, res));
  server.on('connection', (s) => sockets.push(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  target.port = (server.address() as import('net').AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Resolves when every socket the server ever accepted has been closed. */
async function allSocketsClosed(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (sockets.some((s) => !s.destroyed)) {
    if (Date.now() > deadline) throw new Error('a server-side socket is still open');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('safeFetch limits: defaults', () => {
  it('bounds response size and total time by default', () => {
    expect(SAFE_FETCH_MAX_RESPONSE_BYTES).toBe(1024 * 1024);
    expect(SAFE_FETCH_TIMEOUT_MS).toBe(15_000);
  });
});

describe('safeFetch limits: normal responses', () => {
  it('returns a small response unchanged', async () => {
    handler = (_req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain', 'x-test': 'yes' });
      res.end('hello');
    };

    const res = await safeFetch(URL_UNDER_TEST, { method: 'POST', body: '{"a":1}' });

    expect(res.status).toBe(201);
    expect(res.headers.get('x-test')).toBe('yes');
    expect(await res.text()).toBe('hello');
  });

  it('accepts a body of exactly the cap', async () => {
    handler = (_req, res) => res.end('x'.repeat(1000));

    const res = await safeFetch(URL_UNDER_TEST, undefined, { maxResponseBytes: 1000 });

    expect((await res.text()).length).toBe(1000);
  });

  it('accepts a body of exactly the cap that arrives in several chunks', async () => {
    handler = async (_req, res) => {
      res.writeHead(200);
      for (const size of [400, 400, 200]) {
        res.write('x'.repeat(size));
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
    };

    const res = await safeFetch(URL_UNDER_TEST, undefined, { maxResponseBytes: 1000 });

    expect((await res.text()).length).toBe(1000);
  });

  it('rejects a body one byte over the cap that arrives in several chunks', async () => {
    handler = async (_req, res) => {
      res.writeHead(200);
      for (const size of [400, 400, 201]) {
        res.write('x'.repeat(size));
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
    };

    const err = await safeFetch(URL_UNDER_TEST, undefined, { maxResponseBytes: 1000 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('response_too_large');
  });

  it('passes the request body and method to the server', async () => {
    let seen = '';
    handler = (req, res) => {
      req.on('data', (c) => (seen += c));
      req.on('end', () => res.end(req.method));
    };

    const res = await safeFetch(URL_UNDER_TEST, { method: 'POST', body: 'payload' });

    expect(await res.text()).toBe('POST');
    expect(seen).toBe('payload');
  });
});

describe('safeFetch limits: response size cap', () => {
  it('rejects a body one byte over the cap', async () => {
    handler = (_req, res) => res.end('x'.repeat(1001));

    const err = await safeFetch(URL_UNDER_TEST, undefined, { maxResponseBytes: 1000 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('response_too_large');
  });

  it('aborts a response that streams forever and closes the socket', async () => {
    let writes = 0;
    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => {
        writes += 1;
        res.write('x'.repeat(4096));
      }, 1);
      res.on('close', () => clearInterval(timer));
    };

    const err = await safeFetch(URL_UNDER_TEST, undefined, {
      maxResponseBytes: 50_000,
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('response_too_large');
    await allSocketsClosed();
    const writesAtClose = writes;
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toBe(writesAtClose); // the server saw the connection go away
  });

  it('rejects on a declared Content-Length over the cap before any body arrives', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '5000000' });
      res.flushHeaders(); // no body is ever sent
    };

    const err = await safeFetch(URL_UNDER_TEST, undefined, {
      maxResponseBytes: 1000,
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('response_too_large');
    await allSocketsClosed();
  });

  it('applies the default cap when the caller sets none', async () => {
    handler = (_req, res) => res.end('x'.repeat(SAFE_FETCH_MAX_RESPONSE_BYTES + 1));

    const err = await safeFetch(URL_UNDER_TEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SafeFetchLimitError);
  });
});

describe('safeFetch limits: total timeout', () => {
  it('aborts a response whose body never ends and closes the socket', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('start'); // headers and a few bytes, then silence
    };

    const started = Date.now();
    const err = await safeFetch(URL_UNDER_TEST, undefined, { timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    await allSocketsClosed();
  });

  it('aborts a server that accepts the connection but never answers', async () => {
    handler = () => {
      // no response at all
    };

    const err = await safeFetch(URL_UNDER_TEST, undefined, { timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('timeout');
    await allSocketsClosed();
  });

  it('counts the whole exchange, so a trickle of bytes does not extend it', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write('.'), 40);
      res.on('close', () => clearInterval(timer));
    };

    const err = await safeFetch(URL_UNDER_TEST, undefined, { timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SafeFetchLimitError);
    expect((err as SafeFetchLimitError).kind).toBe('timeout');
    await allSocketsClosed();
  });

  it('does not fire after a response that completed in time', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const res = await safeFetch(URL_UNDER_TEST, undefined, { timeoutMs: 123_457 });

      expect(await res.text()).toBe('ok');
      const armed = setTimeoutSpy.mock.results.find(
        (_r, i) => setTimeoutSpy.mock.calls[i][1] === 123_457,
      );
      expect(armed).toBeDefined();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(armed?.value);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe('safeFetch limits: connection lost mid-body', () => {
  it('rejects promptly with the connection error, not a limit error, and closes the socket', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 30);
    };

    const started = Date.now();
    const err = await safeFetch(URL_UNDER_TEST, undefined, { timeoutMs: 3000 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SafeFetchLimitError);
    expect(Date.now() - started).toBeLessThan(1500);
    await allSocketsClosed();
  });
});
