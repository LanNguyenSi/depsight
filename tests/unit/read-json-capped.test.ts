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

  it('parses a body that starts with a UTF-8 BOM, like req.json()', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"repoId":"r1"}')]);

    const result = await readJsonCapped(post(withBom), 100);

    expect(result).toEqual({ ok: true, body: { repoId: 'r1' } });
    // The reference behaviour this mirrors.
    expect(await post(withBom).json()).toEqual({ repoId: 'r1' });
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

const MUTATING = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/g;
const BODY_ACCESS = '(?:clone\\(\\)\\s*\\.\\s*)?(?:json|text|arrayBuffer|formData|blob|bytes|body)\\b';

/**
 * Structural guard for one route.ts source. Returns what is wrong, empty when
 * every request body is read through readJsonCapped or readBodyCapped:
 *  1. No request-typed parameter (NextRequest or Request, any name, handlers
 *     and helpers alike) has its body consumed directly: `.json()`, `.text()`,
 *     `.body`, `.clone().json()` and the like.
 *  2. A POST/PUT/PATCH/DELETE handler that uses its request parameter at all
 *     needs an awaited readJsonCapped/readBodyCapped call in the file. A
 *     handler that never touches its request (`_req`, or no parameter) reads
 *     no body and needs nothing.
 */
function findUncappedBodyReads(source: string): string[] {
  const problems: string[] = [];

  const requestNames = new Set(
    [...source.matchAll(/(\w+)\s*:\s*(?:NextRequest|Request)\b/g)].map((m) => m[1]),
  );
  for (const name of requestNames) {
    const raw = new RegExp(`\\b${name}\\s*\\.\\s*${BODY_ACCESS}`);
    if (raw.test(source)) problems.push(`${name}: body read directly`);
  }

  const capped = /\bawait\s+(?:readJsonCapped|readBodyCapped)\b/.test(source);
  const starts = [...source.matchAll(MUTATING)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? (starts[i + 1].index ?? source.length) : source.length;
    const text = source.slice(m.index ?? 0, end);
    const param = /^[^(]*\(\s*(\w+)\s*:\s*(?:NextRequest|Request)\b/.exec(text)?.[1];
    if (!param) return;
    const afterHeader = text.slice((/\)\s*\{/.exec(text)?.index ?? 0) + 1);
    if (new RegExp(`\\b${param}\\b`).test(afterHeader) && !capped) {
      problems.push(`${m[1]}: uses ${param} without readJsonCapped or readBodyCapped`);
    }
  });
  return problems;
}

describe('request bodies under app/api', () => {
  const files = routeFiles(join(process.cwd(), 'app', 'api'));

  it('finds the route files and the handlers', () => {
    expect(files.length).toBeGreaterThan(20);
    const handlers = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(MUTATING)]);
    expect(handlers.length).toBeGreaterThan(20);
  });

  it('every handler reads its body through readJsonCapped or readBodyCapped', () => {
    const offenders = files.flatMap((f) =>
      findUncappedBodyReads(readFileSync(f, 'utf8')).map((p) => `${f}: ${p}`),
    );

    expect(offenders).toEqual([]);
  });
});

describe('findUncappedBodyReads (the guard itself)', () => {
  const clean = `
    export async function POST(req: NextRequest) {
      const parsed = await readJsonCapped<{ a?: string }>(req);
      if (!parsed.ok) return parsed.response;
      return NextResponse.json(parsed.body);
    }
    export async function DELETE(_req: NextRequest, { params }: RouteParams) {
      return NextResponse.json({});
    }`;

  it('accepts a handler that uses the helper and one that never touches its request', () => {
    expect(findUncappedBodyReads(clean)).toEqual([]);
  });

  it('flags a bare _req.json()', () => {
    const src = `export async function POST(_req: NextRequest) {\n  const b = await _req.json();\n}`;

    expect(findUncappedBodyReads(src).length).toBeGreaterThan(0);
  });

  it('flags req.body.getReader() under another parameter name', () => {
    const src = `export async function PUT(request: Request) {\n  const r = request.body!.getReader();\n}`;

    expect(findUncappedBodyReads(src).length).toBeGreaterThan(0);
  });

  it('flags req.clone().json() and new Response(req.body)', () => {
    expect(
      findUncappedBodyReads(`export async function POST(req: NextRequest) {\n  await req.clone().json();\n}`)
        .length,
    ).toBeGreaterThan(0);
    expect(
      findUncappedBodyReads(
        `export async function PATCH(req: NextRequest) {\n  await new Response(req.body).text();\n}`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('flags a handler that passes its request on without any capped read', () => {
    const src = `export async function POST(req: NextRequest) {\n  const x = await parseSomehow(req);\n}`;

    expect(findUncappedBodyReads(src)).toEqual(['POST: uses req without readJsonCapped or readBodyCapped']);
  });

  it('flags a raw read in a helper outside the exported handlers', () => {
    const src = `async function readBody(request: NextRequest) { return request.json(); }\n${clean}`;

    expect(findUncappedBodyReads(src)).toEqual(['request: body read directly']);
  });
});
