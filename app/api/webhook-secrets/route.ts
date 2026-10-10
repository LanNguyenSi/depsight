import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getWebhookSecretKey, openWebhookSecret } from '@/lib/pr/webhook-secret';

export const dynamic = 'force-dynamic';

/**
 * GET /api/webhook-secrets
 * The signed-in user's tracked repositories and whether each has a PR-scan
 * webhook secret. Only the owner's own rows are listed, and the secret itself
 * (or its sealed form) is never part of the response: it is shown once, when
 * POST /api/webhook-secrets/[repoId] mints it.
 *
 * `configured` says a secret is stored; `usable` says it also opens under the
 * current key material. A configured secret that is not usable (the key
 * material changed, or the value is damaged) never verifies a delivery, so the
 * settings page tells the user to rotate it instead of leaving it looking fine.
 * `available` says key material is present at all (the condition under which
 * minting does not answer 503); without it no secret opens, so the page shows
 * an operator notice instead of telling every user to rotate.
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
    available: getWebhookSecretKey() !== null,
    repos: rows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      configured: row.webhookSecretEnc !== null,
      usable: row.webhookSecretEnc !== null && openWebhookSecret(row.webhookSecretEnc, row.id) !== null,
      rotatedAt: row.webhookSecretRotatedAt,
    })),
  });
}
