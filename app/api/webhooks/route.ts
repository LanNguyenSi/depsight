import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/webhooks — list user's webhook configs
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const webhooks = await prisma.webhookConfig.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
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
    new URL(url); // validate URL format
  } catch {
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
