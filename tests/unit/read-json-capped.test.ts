// Unit tests for lib/http/read-json-capped.ts: the shared body cap of the
// JSON endpoints under app/api, plus the source guard
// (./helpers/body-read-guard.ts) that no route reads its body with a bare
// req.json() again, judged per handler so one capped handler cannot excuse an
// uncapped sibling.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  readJsonCapped,
  bodyTooLargeResponse,
  DEFAULT_JSON_BODY_BYTES,
  ID_LIST_JSON_BODY_BYTES,
} from '@/lib/http/read-json-capped';
import { findUncappedBodyReads, mutatingHandlerNames } from './helpers/body-read-guard';

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

describe('request bodies under app/api', () => {
  const files = routeFiles(join(process.cwd(), 'app', 'api'));

  it('finds the route files and the handlers', () => {
    expect(files.length).toBeGreaterThan(20);
    const handlers = files.flatMap((f) => mutatingHandlerNames(readFileSync(f, 'utf8')));
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

  it('judges each handler on its own: a capped sibling excuses nothing', () => {
    const src = `
      export async function POST(req: NextRequest) {
        const parsed = await readJsonCapped(req);
        return parsed.ok ? NextResponse.json(parsed.body) : parsed.response;
      }
      export async function PUT(req: NextRequest) {
        const b = await parseSomehow(req);
        return NextResponse.json(b);
      }`;

    expect(findUncappedBodyReads(src)).toEqual(['PUT: uses req without readJsonCapped or readBodyCapped']);
  });

  it('flags a body read through an alias of the request', () => {
    const src = `export async function POST(req: NextRequest) {\n  const r = req;\n  const b = await r.json();\n  return NextResponse.json(b);\n}`;
    const problems = findUncappedBodyReads(src);

    expect(problems).toContain('r: body read directly');
    expect(problems).toContain('POST: uses req without readJsonCapped or readBodyCapped');
  });

  it('flags a handler that destructures body out of its request parameter', () => {
    const src = `export async function POST({ body }: NextRequest) {\n  return new Response(body);\n}`;

    expect(findUncappedBodyReads(src)).toEqual(['POST: body read directly']);
  });

  it('flags element access req["json"]() and req["body"]', () => {
    expect(
      findUncappedBodyReads(`export async function POST(req: NextRequest) {\n  return await req['json']();\n}`),
    ).toContain('req: body read directly');
    expect(
      findUncappedBodyReads(`export async function POST(req: NextRequest) {\n  return new Response(req['body']);\n}`),
    ).toContain('req: body read directly');
  });

  it('flags a raw read and a bare hand-off in an arrow-function export', () => {
    const raw = `export const POST = async (req: NextRequest) => {\n  const b = await req.json();\n  return NextResponse.json(b);\n};`;
    expect(findUncappedBodyReads(raw)).toContain('req: body read directly');

    const handed = `import { parseSomehow } from '@/lib/parse';\nexport const POST = async (req: NextRequest) => {\n  const b = await parseSomehow(req);\n  return NextResponse.json(b);\n};`;
    expect(findUncappedBodyReads(handed)).toEqual([
      'POST: uses req without readJsonCapped or readBodyCapped',
    ]);
  });

  it('accepts a header-only DELETE in a file whose POST is capped', () => {
    const src = `
      export async function POST(req: NextRequest) {
        const parsed = await readJsonCapped(req);
        return parsed.ok ? NextResponse.json(parsed.body) : parsed.response;
      }
      export async function DELETE(req: NextRequest) {
        if (req.method !== 'DELETE' || !req.headers.get('authorization')) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return NextResponse.json({ ok: true });
      }`;

    expect(findUncappedBodyReads(src)).toEqual([]);
  });

  it('accepts a handler whose same-file helper does the capped read', () => {
    const src = `
      async function readBody(req: NextRequest) {
        const parsed = await readJsonCapped<unknown>(req);
        return parsed.ok ? parsed.body : null;
      }
      export async function PUT(req: NextRequest) {
        const body = await readBody(req);
        return NextResponse.json({ body });
      }`;

    expect(findUncappedBodyReads(src)).toEqual([]);
  });

  it('accepts an arrow-function export that reads with the capped helper', () => {
    const src = `export const PATCH = async (req: NextRequest) => {\n  const parsed = await readJsonCapped(req);\n  return parsed.ok ? NextResponse.json(parsed.body) : parsed.response;\n};`;

    expect(findUncappedBodyReads(src)).toEqual([]);
  });
});
