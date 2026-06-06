import type { DependencyInfo } from './age-checker';
import { createGitHubClient } from '@/lib/github';
import { collectGoDeps } from '@/lib/manifests/go';

interface GoProxyVersionInfo {
  Version: string;
  Time: string;
}

function encodeGoModulePath(module: string): string {
  return module
    .split('/')
    .map((p) => p.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase()))
    .join('/');
}

function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^v/, '').split('.').map(Number);
  return [cleaned[0] ?? 0, cleaned[1] ?? 0, cleaned[2] ?? 0];
}

function classifyStatus(
  installed: string,
  latest: string,
): DependencyInfo['status'] {
  if (!installed || !latest) return 'UNKNOWN';

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
    installedVersion: version,
    latestVersion: '',
    publishedAt: null,
    ageInDays: -1,
    status: 'UNKNOWN',
    isDeprecated: false,
    updateAvailable: false,
    latestPublishedAt: null,
  };
}

export async function scanGoDeps(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);

  // 1. Read every discovered go.mod (root + workspace modules) and union their
  //    required modules, dropping repo-local modules.
  const modules = await collectGoDeps(octokit, owner, repo, manifestPaths);
  if (modules.length === 0) return [];

  // 2. Query Go proxy for each module in batches
  const BATCH_SIZE = 10;
  const now = new Date();
  const deps: DependencyInfo[] = [];

  for (let i = 0; i < modules.length; i += BATCH_SIZE) {
    const batch = modules.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (mod) => {
        try {
          const encodedPath = encodeGoModulePath(mod.name);

          // Fetch version list
          const listResp = await fetch(
            `https://proxy.golang.org/${encodedPath}/@v/list`,
          );
          if (!listResp.ok) {
            deps.push(makeUnknownDep(mod.name, mod.version));
            return;
          }

          const listText = await listResp.text();
          const versions = listText.trim().split('\n').filter(Boolean);
          const latestVersion = versions.length > 0 ? versions[versions.length - 1] : '';

          // Fetch version info for installed version
          let publishedAt: Date | null = null;
          try {
            const infoResp = await fetch(
              `https://proxy.golang.org/${encodedPath}/@v/${mod.version}.info`,
            );
            if (infoResp.ok) {
              const info = (await infoResp.json()) as GoProxyVersionInfo;
              publishedAt = new Date(info.Time);
            }
          } catch {
            // Graceful degradation — timestamp unavailable
          }

          // Fetch version info for latest version
          let latestPublishedAt: Date | null = null;
          if (latestVersion && latestVersion !== mod.version) {
            try {
              const latestInfoResp = await fetch(
                `https://proxy.golang.org/${encodedPath}/@v/${latestVersion}.info`,
              );
              if (latestInfoResp.ok) {
                const latestInfo = (await latestInfoResp.json()) as GoProxyVersionInfo;
                latestPublishedAt = new Date(latestInfo.Time);
              }
            } catch {
              // Graceful degradation
            }
          } else if (latestVersion === mod.version) {
            latestPublishedAt = publishedAt;
          }

          const ageInDays = publishedAt
            ? Math.floor((now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60 * 24))
            : -1;

          const status = classifyStatus(mod.version, latestVersion);

          deps.push({
            name: mod.name,
            installedVersion: mod.version,
            latestVersion,
            publishedAt,
            ageInDays,
            status,
            isDeprecated: false,
            updateAvailable: status === 'OUTDATED' || status === 'MAJOR_BEHIND',
            latestPublishedAt,
          });
        } catch {
          deps.push(makeUnknownDep(mod.name, mod.version));
        }
      }),
    );
  }

  return deps;
}
