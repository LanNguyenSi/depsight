import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { analyzeDepAge } from '@/lib/deps/age-checker';

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
    where: { id: repoId, userId: session.user.id },
  });
  if (!repo) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  try {
    const result = await analyzeDepAge(session.user.githubToken, repo.owner, repo.name);

    // Persist into Dependency model — upsert per package
    // Use the latest completed scan, or create a new one
    let scan = await prisma.scan.findFirst({
      where: { repoId, status: 'COMPLETED' },
      orderBy: { scannedAt: 'desc' },
    });

    if (!scan) {
      scan = await prisma.scan.create({
        data: { repoId, status: 'COMPLETED' },
      });
    }

    await prisma.$transaction(async (tx) => {
      // Remove old dep entries for this scan
      await tx.dependency.deleteMany({ where: { scanId: scan!.id } });

      if (result.dependencies.length > 0) {
        await tx.dependency.createMany({
          data: result.dependencies.map((d) => ({
            scanId: scan!.id,
            name: d.name,
            installedVersion: d.installedVersion,
            latestVersion: d.latestVersion,
            publishedAt: d.publishedAt,
            ageInDays: d.ageInDays >= 0 ? d.ageInDays : null,
            status: d.status,
            isDeprecated: d.isDeprecated,
            updateAvailable: d.updateAvailable,
            latestPublishedAt: d.latestPublishedAt,
          })),
        });
      }
    });

    return NextResponse.json({
      scanId: scan.id,
      summary: result.summary,
    });
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

  const scan = await prisma.scan.findFirst({
    where: {
      repoId,
      repo: { userId: session.user.id },
      status: 'COMPLETED',
    },
    orderBy: { scannedAt: 'desc' },
    include: {
      dependencies: {
        orderBy: [{ status: 'asc' }, { ageInDays: 'desc' }],
      },
    },
  });

  if (!scan || scan.dependencies.length === 0) {
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
