import { createGitHubClient } from '@/lib/github';
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
 * Parse a pyproject.toml `dependencies` array using simple regex.
 * Handles formats like: "requests>=2.28", "flask==2.3.0", "numpy"
 */
function parsePyprojectToml(content: string): ParsedDep[] {
  const deps: ParsedDep[] = [];

  // Find the [project] section's dependencies array
  const depsBlockMatch = /\bdependencies\s*=\s*\[([^\]]*)\]/s.exec(content);
  if (!depsBlockMatch) return deps;

  const block = depsBlockMatch[1];
  // Extract each quoted string from the array
  const entryPattern = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    const raw = match[1].trim();
    parseDependencySpec(raw, deps);
  }

  return deps;
}

/**
 * Parse requirements.txt lines.
 * Handles: package==1.0.0, package>=1.0.0, package~=1.0.0, package (no version)
 */
function parseRequirementsTxt(content: string): ParsedDep[] {
  const deps: ParsedDep[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // Skip comments, empty lines, and options
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    parseDependencySpec(line, deps);
  }

  return deps;
}

/**
 * Parse a single dependency specifier like "requests>=2.28" into name + version.
 * Strips comparison operators to extract the package name and pinned/minimum version.
 */
function parseDependencySpec(spec: string, deps: ParsedDep[]): void {
  // Remove extras like [security] and environment markers like ; python_version >= "3.8"
  const withoutMarkers = spec.split(';')[0].trim();
  const withoutExtras = withoutMarkers.replace(/\[.*?\]/, '');

  // Split on version operators: ==, >=, <=, ~=, !=, >, <
  const splitMatch = /^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+)\s*(.+)$/.exec(withoutExtras);
  if (splitMatch) {
    const name = splitMatch[1].trim();
    // Take only the first version if there are multiple constraints (e.g. ">=1.0,<2.0")
    const versionPart = splitMatch[2].split(',')[0].trim();
    deps.push({ name, version: versionPart });
  } else {
    // No version specifier
    const name = withoutExtras.trim();
    if (name) {
      deps.push({ name, version: '' });
    }
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
 * Scannt Python-Abhaengigkeiten (pyproject.toml oder requirements.txt) und
 * prueft den Versionsstatus ueber die PyPI-Registry.
 */
export async function scanPythonDeps(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];
  let parsedDeps: ParsedDep[] = [];

  // Try pyproject.toml first, fallback to requirements.txt
  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'pyproject.toml' });
    if ('content' in fileResp.data) {
      const content = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
      parsedDeps = parsePyprojectToml(content);
    }
  } catch {
    // pyproject.toml nicht gefunden, versuche requirements.txt
  }

  if (parsedDeps.length === 0) {
    try {
      const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'requirements.txt' });
      if ('content' in fileResp.data) {
        const content = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
        parsedDeps = parseRequirementsTxt(content);
      }
    } catch {
      // Keine Python-Manifestdatei gefunden
      return [];
    }
  }

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
