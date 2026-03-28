import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { generateSBOM } from '@/lib/sbom/cyclonedx';

export const dynamic = 'force-dynamic';

// GET /api/sbom?repoId=xxx — export SBOM for a repo
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

  // Check that a completed CVE scan exists before generating
  const scan = await prisma.scan.findFirst({
    where: { repoId, status: 'COMPLETED', repo: { userId: session.user.id }, advisories: { some: {} } },
    orderBy: { scannedAt: 'desc' },
    select: { id: true },
  });

  if (!scan) {
    return NextResponse.json(
      { error: 'no_scan', message: 'Kein abgeschlossener Scan vorhanden. Bitte zuerst einen CVE-Scan durchführen.' },
      { status: 404 },
    );
  }

  try {
    const bom = await generateSBOM(session.user.id, repoId);

    const json = JSON.stringify(bom, null, 2);
    const repoName = bom.metadata.component?.name?.replace(/\//g, '-') ?? 'sbom';
    const filename = `${repoName}-sbom.cdx.json`;

    return new NextResponse(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.cyclonedx+json; version=1.4',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(Buffer.byteLength(json, 'utf-8')),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SBOM generation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
