import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/slack — get user's Slack config
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const config = await prisma.slackConfig.findUnique({
    where: { userId: session.user.id },
  });

  return NextResponse.json({ config });
}

// POST /api/slack — create or update Slack config
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    webhookUrl?: string;
    channel?: string;
    minSeverity?: string;
    enabled?: boolean;
  };

  const { webhookUrl, channel, minSeverity, enabled } = body;

  if (!webhookUrl) {
    return NextResponse.json({ error: 'webhookUrl is required' }, { status: 400 });
  }

  try {
    new URL(webhookUrl);
  } catch {
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
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await prisma.slackConfig.deleteMany({ where: { userId: session.user.id } });
  return NextResponse.json({ success: true });
}
