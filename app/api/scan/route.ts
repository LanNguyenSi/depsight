import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { scanRepository } from '@/lib/cve/scanner';

export const dynamic = 'force-dynamic';

// POST /api/scan — trigger a CVE scan for a repository
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
    const result = await scanRepository(session.user.id, repoId, session.user.githubToken);
    return NextResponse.json({
      scanId: result.scanId,
      status: 'completed',
      dependabotDisabled: result.dependabotDisabled ?? false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/scan?repoId=xxx — get latest scan for a repo
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

  // Find latest CVE scan (identified by cvePayload being set by the CVE scanner)
  const scan = await prisma.scan.findFirst({
    where: {
      repoId,
      repo: { userId: session.user.id },
      status: 'COMPLETED',
      cvePayload: { not: Prisma.DbNull },
    },
    orderBy: { scannedAt: 'desc' },
    include: {
      advisories: {
        orderBy: [
          { severity: 'asc' },
          { publishedAt: 'desc' },
        ],
      },
    },
  });

  if (!scan) {
    return NextResponse.json({ scan: null });
  }

  return NextResponse.json({
    scan: {
      id: scan.id,
      scannedAt: scan.scannedAt,
      status: scan.status,
      riskScore: scan.riskScore,
      counts: {
        total: scan.cveCount,
        critical: scan.criticalCount,
        high: scan.highCount,
        medium: scan.mediumCount,
        low: scan.lowCount,
      },
      advisories: scan.advisories.map((a) => ({
        id: a.id,
        ghsaId: a.ghsaId,
        cveId: a.cveId,
        severity: a.severity,
        summary: a.summary,
        packageName: a.packageName,
        ecosystem: a.ecosystem,
        vulnerableRange: a.vulnerableRange,
        fixedVersion: a.fixedVersion,
        publishedAt: a.publishedAt,
        url: a.url,
      })),
    },
  });
}
