import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readJsonCapped } from '@/lib/http/read-json-capped';

export const dynamic = 'force-dynamic';

// The HMAC signing secret is write-only: the response never returns it.
const WEBHOOK_PUBLIC_SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  enabled: true,
  createdAt: true,
} as const;

// DELETE /api/webhooks/[id] — delete webhook config
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  const webhook = await prisma.webhookConfig.findFirst({
    where: { id, userId: session.user.id },
  });

  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.webhookConfig.delete({ where: { id } });
  return NextResponse.json({ success: true });
}

// PATCH /api/webhooks/[id] — enable/disable
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const parsed = await readJsonCapped<{ enabled?: boolean }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const webhook = await prisma.webhookConfig.findFirst({
    where: { id, userId: session.user.id },
  });

  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const updated = await prisma.webhookConfig.update({
    where: { id },
    data: { enabled: body.enabled ?? !webhook.enabled },
    select: WEBHOOK_PUBLIC_SELECT,
  });

  return NextResponse.json({ webhook: updated });
}
