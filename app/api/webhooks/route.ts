import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  assertPublicUrl,
  DNS_BUSY_MESSAGE,
  DNS_UNREACHABLE_MESSAGE,
  SafeFetchLimitError,
  SsrfBlockedError,
} from '@/lib/net/safe-fetch';
import { readJsonCapped } from '@/lib/http/read-json-capped';
import { rateLimitedResponse, webhookCreateRateLimiter, MAX_WEBHOOKS_PER_USER } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// The HMAC signing secret is write-only: no response (list, create or toggle)
// returns it back to the caller.
const WEBHOOK_PUBLIC_SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  enabled: true,
  createdAt: true,
} as const;

// GET /api/webhooks — list user's webhook configs
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const webhooks = await prisma.webhookConfig.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    select: WEBHOOK_PUBLIC_SELECT,
  });

  return NextResponse.json({ webhooks });
}

// POST /api/webhooks — create a webhook config
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Keyed by user id; an unauthenticated request above has already returned
  // and does not count.
  const limit = webhookCreateRateLimiter.check(session.user.id);
  if (!limit.allowed) return rateLimitedResponse(limit);

  const parsed = await readJsonCapped<{
    name?: string;
    url?: string;
    secret?: string;
    events?: string[];
  }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const { name, url, secret, events } = body;

  if (!name || !url || !events?.length) {
    return NextResponse.json({ error: 'name, url, and events are required' }, { status: 400 });
  }

  // Count-then-create without a transaction: concurrent creates can overshoot
  // the cap by the in-flight requests the rate limit above allows. Checked
  // before the SSRF lookup so a user at the cap gets 409 without a DNS call.
  const existing = await prisma.webhookConfig.count({ where: { userId: session.user.id } });
  if (existing >= MAX_WEBHOOKS_PER_USER) {
    return NextResponse.json(
      { error: `A user can have at most ${MAX_WEBHOOKS_PER_USER} webhooks` },
      { status: 409 },
    );
  }

  try {
    await assertPublicUrl(url, { waitForSlot: false }); // save route: refuse at once when the lookup cap is full (SSRF check)
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof SafeFetchLimitError && err.kind === 'timeout') {
      return NextResponse.json({ error: DNS_UNREACHABLE_MESSAGE }, { status: 400 });
    }
    if (err instanceof SafeFetchLimitError && err.kind === 'dns_busy') {
      return NextResponse.json({ error: DNS_BUSY_MESSAGE }, { status: 400 });
    }
    return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
  }

  const validEvents = ['cve.critical', 'cve.high', 'scan.completed'];
  const invalidEvents = events.filter((e) => !validEvents.includes(e));
  if (invalidEvents.length > 0) {
    return NextResponse.json(
      { error: `Invalid events: ${invalidEvents.join(', ')}. Valid: ${validEvents.join(', ')}` },
      { status: 400 },
    );
  }

  const webhook = await prisma.webhookConfig.create({
    data: {
      userId: session.user.id,
      name,
      url,
      secret: secret || null,
      events,
    },
    select: WEBHOOK_PUBLIC_SELECT,
  });

  return NextResponse.json({ webhook }, { status: 201 });
}
