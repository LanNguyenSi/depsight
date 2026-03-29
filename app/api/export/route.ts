import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { scanRepository } from '@/lib/cve/scanner';
import { scanLicenses } from '@/lib/license/scanner';
import { scanDependencies } from '@/lib/deps/scanner';
import {
  buildRepoExportArchive,
  getMissingExportScans,
  loadRepoExportData,
  type RepoExportScanOverrides,
} from '@/lib/export/repo-bundle';

export const dynamic = 'force-dynamic';

// POST /api/export — export CVE, license and dependency results as a zip archive
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as { repoId?: string; runMissingScans?: boolean };
  const { repoId, runMissingScans = false } = body;

  if (!repoId) {
    return NextResponse.json({ error: 'repoId is required' }, { status: 400 });
  }

  try {
    let exportData = await loadRepoExportData(session.user.id, repoId);
    let missingScans = getMissingExportScans(exportData);

    if (missingScans.length > 0 && !runMissingScans) {
      return NextResponse.json(
        {
          error: 'missing_scans',
          missingScans,
        },
        { status: 409 },
      );
    }

    if (missingScans.length > 0) {
      const overrides: RepoExportScanOverrides = {};

      if (missingScans.includes('cve')) {
        const result = await scanRepository(session.user.id, repoId, session.user.githubToken);
        overrides.cveScanId = result.scanId;
      }
      if (missingScans.includes('license')) {
        const result = await scanLicenses(session.user.id, repoId, session.user.githubToken);
        overrides.licenseScanId = result.scanId;
      }
      if (missingScans.includes('deps')) {
        const result = await scanDependencies(session.user.id, repoId, session.user.githubToken);
        overrides.depsScanId = result.scanId;
      }

      exportData = await loadRepoExportData(session.user.id, repoId, overrides);
      missingScans = getMissingExportScans(exportData);

      if (missingScans.length > 0) {
        return NextResponse.json(
          {
            error: 'missing_scans',
            missingScans,
            message: 'Not all scans could be prepared for export.',
          },
          { status: 409 },
        );
      }
    }

    const archive = buildRepoExportArchive(exportData);
    const filename = `${exportData.repo.fullName.replace(/\//g, '-')}-scan-export.zip`;

    return new NextResponse(Buffer.from(archive), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(archive.byteLength),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
