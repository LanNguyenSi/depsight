import { NextResponse } from 'next/server';

/**
 * The 500 answer for an authenticated route, in the `{ error }` shape every
 * route uses.
 *
 * A 500 usually means an unexpected failure whose message was written for the
 * log, not for a caller: a database driver message can carry a host, a
 * downstream API message can carry a token fragment or an internal path. So
 * the raw message never goes into the body; it is written to the server log
 * with the route tag (message only, never the stack, which could quote
 * request data) and the caller gets the route's fixed fallback text, the
 * same text it already got for a non-Error throw.
 *
 * Deliberately not for a controlled answer: a typed error that carries its
 * own status and a message written for the caller (for example
 * `ScanAccessError`) keeps returning both itself.
 */
export function serverError(tag: string, fallback: string, error: unknown): NextResponse {
  const detail = error instanceof Error ? error.message : 'Unknown error';
  console.error(`[${tag}] ${detail}`);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
