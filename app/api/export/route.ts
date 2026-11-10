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
import { getSessionGitHubToken } from '@/lib/auth-api';
import {
  scanRateLimiter,
  licenseRateLimiter,
  depsRateLimiter,
  rateLimitedResponse,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/export — export CVE, license and dependency results as a zip archive
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
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
      // Only an export that actually starts scans spends GitHub/OSV quota, so
      // only then do the scan limiters apply; each missing scan draws on the
      // budget of the endpoint that runs the same scan (POST /api/scan,
      // /api/license, /api/deps). An export of data that already exists never
      // reaches this block.
      const scanLimiters = [
        ['cve', scanRateLimiter],
        ['license', licenseRateLimiter],
        ['deps', depsRateLimiter],
      ] as const;
      for (const [kind, limiter] of scanLimiters) {
        if (!missingScans.includes(kind)) continue;
        const limit = limiter.check(session.user.id);
        if (!limit.allowed) return rateLimitedResponse(limit);
      }

      const githubToken = await getSessionGitHubToken(session.user.id);
      const overrides: RepoExportScanOverrides = {};

      if (missingScans.includes('cve')) {
        const result = await scanRepository(session.user.id, repoId, githubToken);
        // The scanner may hand back an in-flight RUNNING scan instead of a
        // freshly-completed one. Surface that clearly instead of letting it
        // fall through to the generic "not all scans could be prepared" 409
        // below (that scan will still show as missing since it isn't
        // COMPLETED yet). Same pattern applies to license/deps below once
        // those scanners grow an equivalent already-running guard.
        if (result.alreadyRunning) {
          return NextResponse.json(
            {
              error: 'scan_in_progress',
              inProgressScans: ['cve'],
              message: 'A scan is already in progress for this repository; retry shortly.',
            },
            { status: 409 },
          );
        }
        overrides.cveScanId = result.scanId;
      }
      if (missingScans.includes('license')) {
        const result = await scanLicenses(session.user.id, repoId, githubToken);
        overrides.licenseScanId = result.scanId;
      }
      if (missingScans.includes('deps')) {
        const result = await scanDependencies(session.user.id, repoId, githubToken);
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
