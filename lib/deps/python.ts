import { createGitHubClient } from '@/lib/github';
import { collectPythonDeps } from '@/lib/manifests/python';
import type { DependencyInfo, DependencyStatus } from './age-checker';

interface PyPIReleaseFile {
  upload_time_iso_8601?: string;
}

interface PyPIPackageData {
  info?: {
    version?: string;
    license?: string;
  };
  releases?: Record<string, PyPIReleaseFile[]>;
}

function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^[^0-9]*/, '').split('.').map(Number);
  return [cleaned[0] ?? 0, cleaned[1] ?? 0, cleaned[2] ?? 0];
}

function classifyStatus(
  installed: string,
  latest: string,
  isDeprecated: boolean,
): DependencyStatus {
  if (isDeprecated) return 'DEPRECATED';
  if (!installed || installed === 'unknown' || !latest) return 'UNKNOWN';

  try {
    const [iMajor, iMinor, iPatch] = parseVersion(installed);
    const [lMajor, lMinor, lPatch] = parseVersion(latest);

    if (iMajor < lMajor) return 'MAJOR_BEHIND';
    if (iMajor === lMajor && (iMinor < lMinor || (iMinor === lMinor && iPatch < lPatch))) {
      return 'OUTDATED';
    }
    return 'UP_TO_DATE';
  } catch {
    return 'UNKNOWN';
  }
}

function makeUnknownDep(name: string, version: string): DependencyInfo {
  return {
    name,
    installedVersion: version || 'unknown',
    latestVersion: '',
    publishedAt: null,
    ageInDays: -1,
    status: 'UNKNOWN',
    isDeprecated: false,
    updateAvailable: false,
    latestPublishedAt: null,
  };
}

/**
 * Scannt Python-Abhaengigkeiten ueber alle entdeckten Manifeste (pyproject.toml
 * / requirements.txt; Monorepo-Module eingeschlossen) und prueft den
 * Versionsstatus ueber die PyPI-Registry.
 */
export async function scanPythonDeps(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];

  const parsedDeps = await collectPythonDeps(octokit, owner, repo, manifestPaths);
  if (parsedDeps.length === 0) return [];

  // Batch PyPI registry lookups
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 50;
  const now = new Date();

  for (let i = 0; i < parsedDeps.length; i += BATCH_SIZE) {
    if (i > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    const batch = parsedDeps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ name, version }) => {
        try {
          const resp = await fetch(
            `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
            { headers: { Accept: 'application/json' } },
          );
          if (!resp.ok) {
            deps.push(makeUnknownDep(name, version));
            return;
          }

          const data = (await resp.json()) as PyPIPackageData;
          const latestVersion = data.info?.version ?? '';
          const isDeprecated = false; // PyPI hat kein explizites Deprecated-Flag

          // Veroeffentlichungsdatum der installierten Version
          const installedReleaseFiles = version ? data.releases?.[version] : undefined;
          const installedPublishedAt =
            installedReleaseFiles && installedReleaseFiles.length > 0 && installedReleaseFiles[0].upload_time_iso_8601
              ? new Date(installedReleaseFiles[0].upload_time_iso_8601)
              : null;

          // Veroeffentlichungsdatum der neuesten Version
          const latestReleaseFiles = latestVersion ? data.releases?.[latestVersion] : undefined;
          const latestPublishedAt =
            latestReleaseFiles && latestReleaseFiles.length > 0 && latestReleaseFiles[0].upload_time_iso_8601
              ? new Date(latestReleaseFiles[0].upload_time_iso_8601)
              : null;

          const ageInDays = installedPublishedAt
            ? Math.floor((now.getTime() - installedPublishedAt.getTime()) / (1000 * 60 * 60 * 24))
            : -1;

          const installedVersion = version || 'unknown';
          const status = classifyStatus(installedVersion, latestVersion, isDeprecated);

          deps.push({
            name,
            installedVersion,
            latestVersion,
            publishedAt: installedPublishedAt,
            ageInDays,
            status,
            isDeprecated,
            updateAvailable: status === 'OUTDATED' || status === 'MAJOR_BEHIND',
            latestPublishedAt,
          });
        } catch {
          deps.push(makeUnknownDep(name, version));
        }
      }),
    );
  }

  return deps;
}
