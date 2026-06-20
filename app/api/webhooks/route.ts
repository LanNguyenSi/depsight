import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertPublicUrl, SsrfBlockedError } from '@/lib/net/safe-fetch';

export const dynamic = 'force-dynamic';

// GET /api/webhooks — list user's webhook configs
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const webhooks = await prisma.webhookConfig.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, url: true, events: true, enabled: true, createdAt: true },
  });

  return NextResponse.json({ webhooks });
}

// POST /api/webhooks — create a webhook config
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    name?: string;
    url?: string;
    secret?: string;
    events?: string[];
  };

  const { name, url, secret, events } = body;

  if (!name || !url || !events?.length) {
    return NextResponse.json({ error: 'name, url, and events are required' }, { status: 400 });
  }

  try {
    await assertPublicUrl(url); // validate format + reject non-public/internal targets (SSRF)
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
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
  });

  return NextResponse.json({ webhook }, { status: 201 });
}
