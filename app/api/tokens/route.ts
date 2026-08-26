import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ApiTokenScope } from '@prisma/client';

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

// POST /api/tokens — mint a new token. The raw dsat_ value is returned ONCE
// in this response and is never stored anywhere it can be read back.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { name?: unknown; scope?: unknown };
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
      return NextResponse.json({ error: 'invalid scope' }, { status: 400 });
    }
    scope = body.scope as ApiTokenScope;
  }

  const rawToken = 'dsat_' + crypto.randomBytes(32).toString('hex');
  const record = await prisma.apiToken.create({
    data: { userId: session.user.id, token: rawToken, name, scope },
    select: { id: true, name: true, scope: true, createdAt: true },
  });

  // `token` is returned ONCE here and in no other endpoint.
  return NextResponse.json({ token: rawToken, record }, { status: 201 });
}
