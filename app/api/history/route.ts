import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/history?repoId=xxx&limit=30 — get scan history for a repo
export async function GET(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const repoId = searchParams.get('repoId');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '30', 10), 100);

  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required' }, { status: 400 });
  }

  // Verify user owns repo
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId: user.id, tracked: true },
    select: { id: true, fullName: true },
  });

  if (!repo) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  // Get completed CVE scans only (not license/deps scans which have riskScore 0)
  const scans = await prisma.scan.findMany({
    where: {
      repoId,
      status: 'COMPLETED',
      cvePayload: { not: Prisma.DbNull },
    },
    orderBy: { scannedAt: 'asc' },
    take: limit,
    select: {
      id: true,
      scannedAt: true,
      riskScore: true,
      cveCount: true,
      criticalCount: true,
      highCount: true,
      mediumCount: true,
      lowCount: true,
      licenseCount: true,
      licenseIssues: true,
    },
  });

  return NextResponse.json({
    repoId,
    repoName: repo.fullName,
    history: scans.map((s) => ({
      scanId: s.id,
      scannedAt: s.scannedAt.toISOString(),
      riskScore: s.riskScore,
      cveCount: s.cveCount,
      criticalCount: s.criticalCount,
      highCount: s.highCount,
      mediumCount: s.mediumCount,
      lowCount: s.lowCount,
      licenseCount: s.licenseCount,
      licenseIssues: s.licenseIssues,
    })),
  });
}
