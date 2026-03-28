import type { DependencyInfo } from './age-checker';
import { createGitHubClient } from '@/lib/github';

interface GoProxyVersionInfo {
  Version: string;
  Time: string;
}

interface GoModule {
  name: string;
  version: string;
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

function parseGoMod(content: string): GoModule[] {
  const modules: GoModule[] = [];
  const lines = content.split('\n');

  let inRequireBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Single-line require: require github.com/pkg/errors v0.9.1
    if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
      const match = trimmed.match(/^require\s+(\S+)\s+(v\S+)/);
      if (match) {
        modules.push({ name: match[1], version: match[2] });
      }
      continue;
    }

    // Multi-line require block start
    if (trimmed.startsWith('require') && trimmed.includes('(')) {
      inRequireBlock = true;
      continue;
    }

    // Multi-line require block end
    if (inRequireBlock && trimmed === ')') {
      inRequireBlock = false;
      continue;
    }

    // Inside multi-line require block
    if (inRequireBlock) {
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('//')) continue;

      const match = trimmed.match(/^(\S+)\s+(v\S+)/);
      if (match) {
        modules.push({ name: match[1], version: match[2] });
      }
    }
  }

  return modules;
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
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);

  // 1. Read go.mod via GitHub Contents API
  let goModContent: string;
  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'go.mod' });
    if (!('content' in fileResp.data)) {
      return [];
    }
    goModContent = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
  } catch {
    return [];
  }

  // 2. Parse require blocks
  const modules = parseGoMod(goModContent);
  if (modules.length === 0) return [];

  // 3. Query Go proxy for each module in batches
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
