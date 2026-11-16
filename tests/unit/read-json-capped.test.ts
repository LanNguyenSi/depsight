// Unit tests for lib/http/read-json-capped.ts: the shared body cap of the
// JSON endpoints under app/api, plus a source guard that no route reads its
// body with a bare req.json() again.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  readJsonCapped,
  bodyTooLargeResponse,
  DEFAULT_JSON_BODY_BYTES,
  ID_LIST_JSON_BODY_BYTES,
} from '@/lib/http/read-json-capped';

/** A JSON object string of exactly `bytes` bytes ({"a":"xxx..."}). */
function jsonOfSize(bytes: number): string {
  const overhead = '{"a":""}'.length;
  return `{"a":"${'x'.repeat(bytes - overhead)}"}`;
}

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/x', { method: 'POST', body, headers });
}

describe('readJsonCapped', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_JSON_BODY_BYTES).toBe(256 * 1024);
    expect(ID_LIST_JSON_BODY_BYTES).toBe(1024 * 1024);
  });

  it('parses a body under the cap', async () => {
    const result = await readJsonCapped<{ repoId: string }>(post('{"repoId":"r1"}'), 100);

    expect(result).toEqual({ ok: true, body: { repoId: 'r1' } });
  });

  it('parses a body of exactly the cap', async () => {
    const raw = jsonOfSize(1000);
    expect(Buffer.byteLength(raw)).toBe(1000);

    const result = await readJsonCapped(post(raw), 1000);

    expect(result.ok).toBe(true);
  });

  it('rejects a body one byte over the cap with the 413 response', async () => {
    const raw = jsonOfSize(1001);
    expect(Buffer.byteLength(raw)).toBe(1001);

    const result = await readJsonCapped(post(raw), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toEqual({ error: 'Request body too large' });
  });

  it('counts bytes, not characters', async () => {
    // 600 two-byte characters inside a JSON string: 1200 bytes plus the wrapper.
    const raw = JSON.stringify({ a: 'ä'.repeat(600) });

    const result = await readJsonCapped(post(raw), 1000);

    expect(result.ok).toBe(false);
  });

  it('uses the default cap when none is given', async () => {
    const under = await readJsonCapped(post(jsonOfSize(DEFAULT_JSON_BODY_BYTES)));
    const over = await readJsonCapped(post(jsonOfSize(DEFAULT_JSON_BODY_BYTES + 1)));

    expect(under.ok).toBe(true);
    expect(over.ok).toBe(false);
  });

  it('rejects on the declared Content-Length without touching the body', async () => {
    let bodyAccessed = false;
    const req = {
      headers: new Headers({ 'content-length': '1001' }),
      get body() {
        bodyAccessed = true;
        return null;
      },
    } as unknown as Request;

    const result = await readJsonCapped(req, 1000);

    expect(result.ok).toBe(false);
    expect(bodyAccessed).toBe(false);
  });

  it('caps a chunked body that has no Content-Length and stops reading early', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(100));
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();

    const result = await readJsonCapped(req, 1000);

    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
    // The cap is crossed at the 11th chunk; the stream is not drained.
    expect(pulls).toBeLessThan(50);
  });

  it('parses a chunked body within the cap', async () => {
    const parts = ['{"a"', ':', '"b"}'].map((p) => new TextEncoder().encode(p));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        parts.forEach((p) => controller.enqueue(p));
        controller.close();
      },
    });
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    expect(await readJsonCapped(req, 100)).toEqual({ ok: true, body: { a: 'b' } });
  });

  it('throws SyntaxError for malformed JSON, like req.json()', async () => {
    await expect(readJsonCapped(post('{not json'), 100)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('throws SyntaxError for an empty body, like req.json()', async () => {
    const req = new Request('http://localhost/x', { method: 'POST' });

    await expect(readJsonCapped(req, 100)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('answers 413 in the error shape the routes use', async () => {
    const res = bodyTooLargeResponse();

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
  });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('request bodies under app/api', () => {
  const files = routeFiles(join(process.cwd(), 'app', 'api'));

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no handler reads its body with a bare req.json() or request.json()', () => {
    const offenders = files.filter((f) =>
      /\b(req|request)\s*\.\s*(json|text|arrayBuffer|formData|blob)\s*\(/.test(
        readFileSync(f, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });
});
