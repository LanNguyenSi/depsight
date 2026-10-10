import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser, hasWriteScope } from '@/lib/auth-api';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { scanRepository, ScanAccessError } from '@/lib/cve/scanner';
import { scanRateLimiter, rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/scan: trigger a CVE scan for a repository. Persists scan
// results and spends the owner's GitHub API quota, so it requires the
// WRITE scope (a READ-scoped dsat_ token gets 403); GET below stays open
// to both scopes. Rate limited per user (lib/rate-limit.ts), session and
// token callers alike: over the limit the answer is 429 with Retry-After.
export async function POST(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
  }

  const limit = scanRateLimiter.check(user.id);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
  }

  const body = await req.json() as { repoId?: string };
  const { repoId } = body;

  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required' }, { status: 400 });
  }

  try {
    const result = await scanRepository(user.id, repoId, user.githubToken);
    return NextResponse.json({
      scanId: result.scanId,
      status: result.alreadyRunning ? 'running' : 'completed',
      alreadyRunning: result.alreadyRunning ?? false,
      dependabotDisabled: result.dependabotDisabled ?? false,
      degradedReason: result.degradedReason ?? null,
    });
  } catch (error) {
    if (error instanceof ScanAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Scan failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/scan?repoId=xxx — get latest scan for a repo
export async function GET(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
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
      repo: { userId: user.id, tracked: true },
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

  // Triage state per finding (acknowledged / ignored), keyed by advisory id +
  // package. Informational only: the counts and risk score below still include
  // every advisory, ignored ones too.
  const states = await prisma.advisoryState.findMany({
    where: { repoId },
    include: { setBy: { select: { githubLogin: true } } },
  });
  const stateByKey = new Map(
    states.map((st) => [
      `${st.ghsaId} ${st.packageName}`,
      {
        status: st.status,
        note: st.note,
        setBy: st.setBy.githubLogin,
        setAt: st.updatedAt,
      },
    ]),
  );

  return NextResponse.json({
    scan: {
      id: scan.id,
      scannedAt: scan.scannedAt,
      status: scan.status,
      degradedReason: scan.degradedReason,
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
        source: a.source,
        severity: a.severity,
        summary: a.summary,
        packageName: a.packageName,
        ecosystem: a.ecosystem,
        vulnerableRange: a.vulnerableRange,
        fixedVersion: a.fixedVersion,
        publishedAt: a.publishedAt,
        url: a.url,
        state: stateByKey.get(`${a.ghsaId} ${a.packageName}`) ?? null,
      })),
    },
  });
}
