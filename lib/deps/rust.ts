import { createGitHubClient } from '@/lib/github';
import type { DependencyInfo, DependencyStatus } from './age-checker';

interface CrateVersion {
  num: string;
  created_at: string;
  yanked: boolean;
}

interface CrateData {
  crate: {
    max_stable_version?: string;
    newest_version?: string;
  };
  versions: CrateVersion[];
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
 * Parse a Cargo.toml file to extract dependencies.
 * Handles formats:
 *   serde = "1.0"
 *   serde = { version = "1.0", features = [...] }
 *   tokio = { version = "1", ... }
 */
function parseCargoToml(content: string): ParsedDep[] {
  const deps: ParsedDep[] = [];
  const lines = content.split('\n');

  let inDepsSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect section headers
    if (line.startsWith('[')) {
      inDepsSection =
        line === '[dependencies]' ||
        line === '[dev-dependencies]';
      continue;
    }

    if (!inDepsSection || !line || line.startsWith('#')) continue;

    // Match: name = "version"
    const simpleMatch = /^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (simpleMatch) {
      deps.push({ name: simpleMatch[1], version: simpleMatch[2] });
      continue;
    }

    // Match: name = { version = "version", ... }
    const tableMatch = /^([a-zA-Z0-9_-]+)\s*=\s*\{.*?version\s*=\s*"([^"]*)"/.exec(line);
    if (tableMatch) {
      deps.push({ name: tableMatch[1], version: tableMatch[2] });
    }
  }

  return deps;
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
 * Scan Rust dependencies from Cargo.toml and check version status
 * via the crates.io registry.
 */
export async function scanRustDeps(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];
  let parsedDeps: ParsedDep[] = [];

  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'Cargo.toml' });
    if ('content' in fileResp.data) {
      const content = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
      parsedDeps = parseCargoToml(content);
    }
  } catch {
    // No Cargo.toml found
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
          const resp = await fetch(
            `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
            {
              headers: {
                Accept: 'application/json',
                'User-Agent': 'depsight/1.0 (https://github.com/depsight)',
              },
            },
          );
          if (!resp.ok) {
            deps.push(makeUnknownDep(name, version));
            return;
          }

          const data = (await resp.json()) as CrateData;
          const latestVersion = data.crate.max_stable_version ?? data.crate.newest_version ?? '';

          // Check if all versions are yanked (effectively deprecated)
          const allYanked = data.versions.length > 0 && data.versions.every((v) => v.yanked);
          const isDeprecated = allYanked;

          // Find publish date for installed version
          const installedVersionEntry = data.versions.find((v) => v.num === version);
          const publishedAt = installedVersionEntry
            ? new Date(installedVersionEntry.created_at)
            : null;

          // Find publish date for latest version
          const latestVersionEntry = data.versions.find((v) => v.num === latestVersion);
          const latestPublishedAt = latestVersionEntry
            ? new Date(latestVersionEntry.created_at)
            : null;

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
