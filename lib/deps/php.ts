import { createGitHubClient } from '@/lib/github';
import { collectPhpDeps } from '@/lib/manifests/php';
import type { DependencyInfo, DependencyStatus } from './age-checker';

interface PackagistVersionEntry {
  version: string;
  version_normalized: string;
  time?: string;
}

interface PackagistData {
  packages: Record<string, PackagistVersionEntry[]>;
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

/**
 * Find the latest stable (non-dev) version from a Packagist versions array.
 */
function findLatestStable(versions: PackagistVersionEntry[]): PackagistVersionEntry | undefined {
  for (const v of versions) {
    const ver = v.version.toLowerCase();
    if (ver.includes('dev') || ver.includes('alpha') || ver.includes('beta') || ver.includes('rc')) {
      continue;
    }
    // Packagist returns versions sorted newest-first
    return v;
  }
  return undefined;
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
 * Scan PHP dependencies across all discovered composer.json manifests (root +
 * monorepo packages) and check version status via the Packagist registry.
 */
export async function scanPhpDeps(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];

  const parsedDeps = await collectPhpDeps(octokit, owner, repo, manifestPaths);
  if (parsedDeps.length === 0) return [];

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
          // Packagist p2 endpoint expects vendor/package
          const resp = await fetch(
            `https://repo.packagist.org/p2/${name}.json`,
            { headers: { Accept: 'application/json' } },
          );
          if (!resp.ok) {
            deps.push(makeUnknownDep(name, version));
            return;
          }

          const data = (await resp.json()) as PackagistData;
          const packageVersions = data.packages[name];
          if (!packageVersions || packageVersions.length === 0) {
            deps.push(makeUnknownDep(name, version));
            return;
          }

          const latestStable = findLatestStable(packageVersions);
          const latestVersion = latestStable?.version?.replace(/^v/, '') ?? '';
          const isDeprecated = false;

          // Find publish date for installed version
          const installedEntry = packageVersions.find((v) => {
            const normalizedVer = v.version.replace(/^v/, '');
            return normalizedVer === version;
          });
          const publishedAt = installedEntry?.time ? new Date(installedEntry.time) : null;

          // Publish date for latest version
          const latestPublishedAt = latestStable?.time ? new Date(latestStable.time) : null;

          const ageInDays = publishedAt
            ? Math.floor((now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60 * 24))
            : -1;

          const installedVersion = version || 'unknown';
          const status = classifyStatus(installedVersion, latestVersion, isDeprecated);

          deps.push({
            name,
            installedVersion,
            latestVersion,
            publishedAt,
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
