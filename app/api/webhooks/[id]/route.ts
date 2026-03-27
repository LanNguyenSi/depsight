import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// DELETE /api/webhooks/[id] — delete webhook config
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json() as { enabled?: boolean };

  const webhook = await prisma.webhookConfig.findFirst({
    where: { id, userId: session.user.id },
  });

  if (!webhook) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const updated = await prisma.webhookConfig.update({
    where: { id },
    data: { enabled: body.enabled ?? !webhook.enabled },
  });

  return NextResponse.json({ webhook: updated });
}
