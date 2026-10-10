import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  generateWebhookSecret,
  getWebhookSecretKey,
  sealWebhookSecret,
} from '@/lib/pr/webhook-secret';
import { rateLimitedResponse, webhookSecretRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/webhook-secrets/[repoId]
 * Mints the PR-scan webhook secret of one of the caller's tracked repositories,
 * or rotates it when one exists (the old secret stops verifying at once). The
 * plaintext is in this response and nowhere else: depsight keeps it sealed
 * (AES-256-GCM) and cannot show it again. Session only, owner only: an API
 * token cannot mint one, and a repository row of another user is a 404.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ repoId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const limit = webhookSecretRateLimiter.check(userId);
  if (!limit.allowed) return rateLimitedResponse(limit);

  if (!getWebhookSecretKey()) {
    return NextResponse.json({ error: 'Webhook secrets are not available' }, { status: 503 });
  }

  const { repoId } = await params;
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId },
    select: { id: true, fullName: true, tracked: true },
  });
  if (!repo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!repo.tracked) {
    return NextResponse.json({ error: 'Repository is not tracked' }, { status: 409 });
  }

  const secret = generateWebhookSecret();
  const rotatedAt = new Date();
  // The owner stays in the write's own filter, so the update cannot land on a
  // row that stopped being the caller's between the read and the write.
  const result = await prisma.repo.updateMany({
    where: { id: repo.id, userId, tracked: true },
    data: { webhookSecretEnc: sealWebhookSecret(secret, repo.id), webhookSecretRotatedAt: rotatedAt },
  });
  if (result.count !== 1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(
    { secret, rotatedAt, repository: repo.fullName },
    { headers: NO_STORE },
  );
}

/**
 * DELETE /api/webhook-secrets/[repoId]
 * Removes the secret: deliveries for this user's row stop verifying and scan
 * nothing. Owner only.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ repoId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { repoId } = await params;
  const result = await prisma.repo.updateMany({
    where: { id: repoId, userId: session.user.id },
    data: { webhookSecretEnc: null, webhookSecretRotatedAt: null },
  });
  if (result.count !== 1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
