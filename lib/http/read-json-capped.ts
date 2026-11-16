import { NextResponse } from 'next/server';
import { readBodyCapped } from '@/lib/pr/webhook-security';

/**
 * Body cap for the JSON endpoints under app/api. Their largest legitimate
 * bodies are a policy rule or a handful of identifiers (well under 10 KB);
 * nothing accepts an upload. 256 KiB leaves wide headroom and still stops a
 * signed-in caller from making the single app process buffer a large body.
 */
export const DEFAULT_JSON_BODY_BYTES = 256 * 1024;

/**
 * Cap for a body that carries a list of repository ids (POST
 * /api/dependabot/enable-all): one id is about 28 bytes, so 1 MiB holds
 * roughly 37,000 of them.
 */
export const ID_LIST_JSON_BODY_BYTES = 1024 * 1024;

export type CappedJson<T> = { ok: true; body: T } | { ok: false; response: NextResponse };

/** The 413 answer, in the `{ error }` shape every route uses. */
export function bodyTooLargeResponse(): NextResponse {
  return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
}

/**
 * Drop-in for `await req.json()` that never buffers more than `maxBytes`.
 *
 * - Over the cap (declared Content-Length, or counted while streaming, which
 *   also covers chunked bodies without a length): `{ ok: false, response }`
 *   with a 413, and the rest of the stream is cancelled unread.
 * - Within the cap: the parsed JSON. Malformed or empty JSON throws the same
 *   SyntaxError `req.json()` throws, so a route keeps whatever handling (or
 *   lack of it) it had for invalid JSON.
 *
 * Not for POST /api/webhooks/github, whose signature needs the raw bytes
 * (it calls `readBodyCapped` itself).
 */
export async function readJsonCapped<T = unknown>(
  req: Request,
  maxBytes: number = DEFAULT_JSON_BODY_BYTES,
): Promise<CappedJson<T>> {
  const raw = await readBodyCapped(req, maxBytes);
  if (raw === null) return { ok: false, response: bodyTooLargeResponse() };
  // TextDecoder drops a leading UTF-8 BOM, as Request.json() does.
  return { ok: true, body: JSON.parse(new TextDecoder('utf-8').decode(raw)) as T };
}
