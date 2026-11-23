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
import { rateLimitedResponse, slackConfigRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// GET /api/slack — get user's Slack config
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const config = await prisma.slackConfig.findUnique({
    where: { userId: session.user.id },
  });

  return NextResponse.json({ config });
}

// POST /api/slack — create or update Slack config
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Keyed by user id; an unauthenticated request above has already returned
  // and does not count. No count cap: this is an upsert, one row per user.
  const limit = slackConfigRateLimiter.check(session.user.id);
  if (!limit.allowed) return rateLimitedResponse(limit);

  const parsed = await readJsonCapped<{
    webhookUrl?: string;
    channel?: string;
    minSeverity?: string;
    enabled?: boolean;
  }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const { webhookUrl, channel, minSeverity, enabled } = body;

  if (!webhookUrl) {
    return NextResponse.json({ error: 'webhookUrl is required' }, { status: 400 });
  }

  try {
    await assertPublicUrl(webhookUrl, { waitForSlot: false }); // save route: refuse at once when the lookup cap is full (SSRF check)
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
    return NextResponse.json({ error: 'Invalid webhookUrl format' }, { status: 400 });
  }

  const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  if (minSeverity && !validSeverities.includes(minSeverity)) {
    return NextResponse.json(
      { error: `Invalid minSeverity. Valid: ${validSeverities.join(', ')}` },
      { status: 400 },
    );
  }

  const config = await prisma.slackConfig.upsert({
    where: { userId: session.user.id },
    update: {
      webhookUrl,
      channel: channel ?? null,
      minSeverity: (minSeverity as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW') ?? 'HIGH',
      enabled: enabled ?? true,
    },
    create: {
      userId: session.user.id,
      webhookUrl,
      channel: channel ?? null,
      minSeverity: (minSeverity as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW') ?? 'HIGH',
      enabled: enabled ?? true,
    },
  });

  return NextResponse.json({ config });
}

// DELETE /api/slack — remove Slack config
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await prisma.slackConfig.deleteMany({ where: { userId: session.user.id } });
  return NextResponse.json({ success: true });
}
