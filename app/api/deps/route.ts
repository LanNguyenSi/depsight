import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { scanDependencies } from '@/lib/deps/scanner';

export const dynamic = 'force-dynamic';

// POST /api/deps — trigger dependency age analysis
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

  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId: session.user.id, tracked: true },
  });
  if (!repo) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  try {
    const result = await scanDependencies(session.user.id, repoId, session.user.githubToken);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Dependency analysis failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/deps?repoId=xxx — get dependency age results
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

  // Find latest scan that actually has dependency data
  const scan = await prisma.scan.findFirst({
    where: {
      repoId,
      repo: { userId: session.user.id, tracked: true },
      status: 'COMPLETED',
      OR: [
        { dependencies: { some: {} } },
        {
          cvePayload: { equals: Prisma.DbNull },
          licensePayload: { equals: Prisma.DbNull },
          advisories: { none: {} },
          licenses: { none: {} },
        },
      ],
    },
    orderBy: { scannedAt: 'desc' },
    include: {
      dependencies: {
        orderBy: [{ status: 'asc' }, { ageInDays: 'desc' }],
      },
    },
  });

  if (!scan) {
    return NextResponse.json({ dependencies: [], summary: null });
  }

  const deps = scan.dependencies;
  const summary = {
    total: deps.length,
    upToDate: deps.filter((d) => d.status === 'UP_TO_DATE').length,
    outdated: deps.filter((d) => d.status === 'OUTDATED').length,
    majorBehind: deps.filter((d) => d.status === 'MAJOR_BEHIND').length,
    deprecated: deps.filter((d) => d.status === 'DEPRECATED').length,
    unknown: deps.filter((d) => d.status === 'UNKNOWN').length,
  };

  return NextResponse.json({
    scanId: scan.id,
    scannedAt: scan.scannedAt,
    summary,
    dependencies: deps.map((d) => ({
      id: d.id,
      name: d.name,
      installedVersion: d.installedVersion,
      latestVersion: d.latestVersion,
      ageInDays: d.ageInDays,
      status: d.status,
      isDeprecated: d.isDeprecated,
      updateAvailable: d.updateAvailable,
      publishedAt: d.publishedAt,
      latestPublishedAt: d.latestPublishedAt,
    })),
  });
}
