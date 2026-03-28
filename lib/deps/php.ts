import { createGitHubClient } from '@/lib/github';
import type { DependencyInfo, DependencyStatus } from './age-checker';

interface PackagistVersionEntry {
  version: string;
  version_normalized: string;
  time?: string;
}

interface PackagistData {
  packages: Record<string, PackagistVersionEntry[]>;
}

interface ParsedDep {
  name: string;
  version: string;
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
 * Parse composer.json to extract production dependencies.
 * Skips `php` and `ext-*` entries (PHP extensions, not packages).
 */
function parseComposerJson(content: string): ParsedDep[] {
  const deps: ParsedDep[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return deps;
  }

  const require = parsed.require as Record<string, string> | undefined;
  if (!require || typeof require !== 'object') return deps;

  for (const [name, version] of Object.entries(require)) {
    // Skip PHP itself and extensions
    if (name === 'php' || name.startsWith('ext-')) continue;

    // Clean version constraint: strip ^, ~, >=, etc. to get base version
    const cleanVersion = String(version).replace(/^[^0-9]*/, '').split(',')[0].trim();
    deps.push({ name, version: cleanVersion });
  }

  return deps;
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
 * Scan PHP dependencies from composer.json and check version status
 * via the Packagist registry.
 */
export async function scanPhpDeps(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];
  let parsedDeps: ParsedDep[] = [];

  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'composer.json' });
    if ('content' in fileResp.data) {
      const content = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
      parsedDeps = parseComposerJson(content);
    }
  } catch {
    // No composer.json found
    return [];
  }

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
