import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ApiTokenScope } from '@prisma/client';
import { generateApiToken, hashApiToken } from '@/lib/api-token';
import { readJsonCapped } from '@/lib/http/read-json-capped';
import { rateLimitedResponse, apiTokenCreateRateLimiter, MAX_API_TOKENS_PER_USER } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// API-token management is intentionally session-only (auth(), not
// resolveRequestUser): a dsat_ token must never be able to mint, list, or
// revoke tokens, otherwise a leaked token could escalate into more tokens.

// GET /api/tokens — list the caller's tokens (metadata only, never the raw value).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tokens = await prisma.apiToken.findMany({
    where: { userId: session.user.id },
    select: {
      id: true,
      name: true,
      scope: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ tokens });
}

// POST /api/tokens — mint a new token. The raw dsat_ value is returned once
// here; only its SHA-256 hash is stored (lookup hashes the presented token),
// so no endpoint and no database dump can return it again.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Keyed by user id; an unauthenticated request above has already returned
  // and does not count.
  const limit = apiTokenCreateRateLimiter.check(session.user.id);
  if (!limit.allowed) return rateLimitedResponse(limit);

  let body: { name?: unknown; scope?: unknown } = {};
  try {
    const parsed = await readJsonCapped<{ name?: unknown; scope?: unknown }>(req);
    if (!parsed.ok) return parsed.response;
    body = parsed.body;
  } catch {
    // Malformed JSON is treated as an empty body (answered by the name check).
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'A token name is required' }, { status: 400 });
  }
  if (name.length > 100) {
    return NextResponse.json(
      { error: 'Token name is too long (max 100 characters)' },
      { status: 400 },
    );
  }

  // Defaults to WRITE (today's behaviour) when omitted, so any caller that
  // does not yet know about scope (the CLI helper, older API docs) keeps
  // minting full-access tokens exactly as before. The token UI always sends
  // an explicit scope.
  let scope: ApiTokenScope = ApiTokenScope.WRITE;
  if (body.scope !== undefined) {
    if (!Object.values(ApiTokenScope).includes(body.scope as ApiTokenScope)) {
      return NextResponse.json({ error: 'Invalid token scope (expected READ or WRITE)' }, { status: 400 });
    }
    scope = body.scope as ApiTokenScope;
  }

  // Per-user cap on active tokens, checked before minting: revoked rows are
  // excluded so revoking frees room. Count-then-create without a transaction,
  // so two simultaneous requests can overshoot by at most one (bounded).
  const activeTokens = await prisma.apiToken.count({
    where: { userId: session.user.id, revokedAt: null },
  });
  if (activeTokens >= MAX_API_TOKENS_PER_USER) {
    return NextResponse.json(
      { error: `A user can have at most ${MAX_API_TOKENS_PER_USER} active API tokens` },
      { status: 409 },
    );
  }

  const rawToken = generateApiToken();
  const record = await prisma.apiToken.create({
    data: { userId: session.user.id, token: hashApiToken(rawToken), name, scope },
    select: { id: true, name: true, scope: true, createdAt: true },
  });

  // `token` is returned ONCE here and in no other endpoint.
  return NextResponse.json({ token: rawToken, record }, { status: 201 });
}
