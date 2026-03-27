import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scanLicenses } from '@/lib/license/scanner';

export const dynamic = 'force-dynamic';

// POST /api/license — trigger license scan for a repo
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as { repoId?: string };
  const { repoId } = body;

  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required' }, { status: 400 });
  }

  try {
    const result = await scanLicenses(session.user.id, repoId, session.user.githubToken);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'License scan failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/license?repoId=xxx — get license results for a repo
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const repoId = searchParams.get('repoId');

  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required' }, { status: 400 });
  }

  const scan = await prisma.scan.findFirst({
    where: {
      repoId,
      repo: { userId: session.user.id },
      status: 'COMPLETED',
    },
    orderBy: { scannedAt: 'desc' },
    include: {
      licenses: {
        orderBy: [{ policyViolation: 'desc' }, { isCompatible: 'asc' }],
      },
    },
  });

  if (!scan) {
    return NextResponse.json({ licenses: [], summary: {}, conflictCount: 0 });
  }

  // Build summary
  const summary: Record<string, number> = {};
  for (const l of scan.licenses) {
    summary[l.license] = (summary[l.license] ?? 0) + 1;
  }

  return NextResponse.json({
    scanId: scan.id,
    scannedAt: scan.scannedAt,
    licenseCount: scan.licenseCount,
    conflictCount: scan.licenseIssues,
    summary,
    licenses: scan.licenses.map((l) => ({
      id: l.id,
      packageName: l.packageName,
      version: l.version,
      license: l.license,
      isCompatible: l.isCompatible,
      policyViolation: l.policyViolation,
    })),
  });
}
