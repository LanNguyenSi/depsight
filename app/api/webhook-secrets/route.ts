import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/webhook-secrets
 * The signed-in user's tracked repositories and whether each has a PR-scan
 * webhook secret. Only the owner's own rows are listed, and the secret itself
 * (or its sealed form) is never part of the response: it is shown once, when
 * POST /api/webhook-secrets/[repoId] mints it.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await prisma.repo.findMany({
    where: { userId: session.user.id, tracked: true },
    orderBy: { fullName: 'asc' },
    select: { id: true, fullName: true, webhookSecretEnc: true, webhookSecretRotatedAt: true },
  });

  return NextResponse.json({
    repos: rows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      configured: row.webhookSecretEnc !== null,
      rotatedAt: row.webhookSecretRotatedAt,
    })),
  });
}
