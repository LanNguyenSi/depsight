import { createGitHubClient } from '@/lib/github';
import { detectEcosystem, getEcosystemLabel, type Ecosystem } from '@/lib/ecosystem';

import type { DepStatus } from '@prisma/client';
export type DependencyStatus = DepStatus;

export interface DependencyInfo {
  name: string;
  installedVersion: string;
  latestVersion: string;
  publishedAt: Date | null;
  ageInDays: number;
  status: DependencyStatus;
  isDeprecated: boolean;
  updateAvailable: boolean;
  latestPublishedAt: Date | null;
}

export interface DepAgeScanResult {
  dependencies: DependencyInfo[];
  summary: {
    total: number;
    upToDate: number;
    outdated: number;
    majorBehind: number;
    deprecated: number;
    unknown: number;
    outdatedPercent: number;
  };
  unsupportedEcosystem?: { ecosystem: Ecosystem; label: string };
}

interface NpmPackageData {
  version?: string;
  time?: Record<string, string>;
  deprecated?: string;
  'dist-tags'?: {
    latest?: string;
  };
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

export async function analyzeDepAge(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<DepAgeScanResult> {
  // Check ecosystem — only npm supported
  const ecosystemInfo = await detectEcosystem(accessToken, owner, repo);
  if (!ecosystemInfo.supported && ecosystemInfo.ecosystem !== 'unknown') {
    return {
      ...buildResult([]),
      unsupportedEcosystem: {
        ecosystem: ecosystemInfo.ecosystem,
        label: getEcosystemLabel(ecosystemInfo.ecosystem),
      },
    };
  }

  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];

  // Fetch package.json
  let packageJsonContent: string | null = null;
  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'package.json' });
    if ('content' in fileResp.data) {
      packageJsonContent = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
    }
  } catch {
    return buildResult([]);
  }

  if (!packageJsonContent) return buildResult([]);

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(packageJsonContent) as Record<string, unknown>;
  } catch {
    return buildResult([]);
  }

  // Combine prod + dev deps
  const allDeps: Array<{ name: string; versionSpec: string; isDev: boolean }> = [];
  for (const [name, spec] of Object.entries(pkg.dependencies as Record<string, string> ?? {})) {
    allDeps.push({ name, versionSpec: String(spec), isDev: false });
  }
  for (const [name, spec] of Object.entries(pkg.devDependencies as Record<string, string> ?? {})) {
    allDeps.push({ name, versionSpec: String(spec), isDev: true });
  }

  // Batch npm registry lookups
  const BATCH_SIZE = 10;
  const now = new Date();

  for (let i = 0; i < allDeps.length; i += BATCH_SIZE) {
    const batch = allDeps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ name, versionSpec }) => {
        try {
          const resp = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(name)}`,
            { headers: { Accept: 'application/json' } },
          );
          if (!resp.ok) {
            deps.push(makeUnknownDep(name, versionSpec));
            return;
          }

          const data = await resp.json() as NpmPackageData;
          const latestVersion = data['dist-tags']?.latest ?? '';
          const isDeprecated = Boolean(data.deprecated);

          // Get publish date for installed version
          const cleanInstalled = versionSpec.replace(/^[^0-9]*/, '');
          const installedPublishedAt = data.time?.[cleanInstalled]
            ? new Date(data.time[cleanInstalled])
            : null;

          // Get publish date for latest version
          const latestPublishedAt = latestVersion && data.time?.[latestVersion]
            ? new Date(data.time[latestVersion])
            : null;

          const ageInDays = installedPublishedAt
            ? Math.floor((now.getTime() - installedPublishedAt.getTime()) / (1000 * 60 * 60 * 24))
            : -1;

          const status = classifyStatus(cleanInstalled, latestVersion, isDeprecated);

          deps.push({
            name,
            installedVersion: cleanInstalled || versionSpec,
            latestVersion,
            publishedAt: installedPublishedAt,
            ageInDays,
            status,
            isDeprecated,
            updateAvailable: status === 'OUTDATED' || status === 'MAJOR_BEHIND',
            latestPublishedAt,
          });
        } catch {
          deps.push(makeUnknownDep(name, versionSpec));
        }
      }),
    );
  }

  return buildResult(deps);
}

function makeUnknownDep(name: string, versionSpec: string): DependencyInfo {
  return {
    name,
    installedVersion: versionSpec.replace(/^[^0-9]*/, '') || versionSpec,
    latestVersion: '',
    publishedAt: null,
    ageInDays: -1,
    status: 'UNKNOWN',
    isDeprecated: false,
    updateAvailable: false,
    latestPublishedAt: null,
  };
}

function buildResult(deps: DependencyInfo[]): DepAgeScanResult {
  const summary = {
    total: deps.length,
    upToDate: deps.filter((d) => d.status === 'UP_TO_DATE').length,
    outdated: deps.filter((d) => d.status === 'OUTDATED').length,
    majorBehind: deps.filter((d) => d.status === 'MAJOR_BEHIND').length,
    deprecated: deps.filter((d) => d.status === 'DEPRECATED').length,
    unknown: deps.filter((d) => d.status === 'UNKNOWN').length,
    outdatedPercent: 0,
  };
  const outdatedTotal = summary.outdated + summary.majorBehind + summary.deprecated;
  summary.outdatedPercent = summary.total > 0 ? Math.round((outdatedTotal / summary.total) * 100) : 0;

  // Sort: deprecated → major_behind → outdated → unknown → up_to_date
  const ORDER: Record<DependencyStatus, number> = {
    DEPRECATED: 0, MAJOR_BEHIND: 1, OUTDATED: 2, UNKNOWN: 3, UP_TO_DATE: 4,
  };
  deps.sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  return { dependencies: deps, summary };
}
