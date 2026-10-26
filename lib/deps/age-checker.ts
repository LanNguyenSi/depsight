import { createGitHubClient } from '@/lib/github';
import { collectNpmReportVersions, type NpmReportVersion } from '@/lib/cve/osv';
import { noteDegraded } from '@/lib/scan/degraded';
import { getEcosystemLabel, type Ecosystem } from '@/lib/ecosystem';
import {
  detectEcosystem,
  fetchNpmManifests,
  unionNpmDeps,
  type FetchedManifest,
  type ObservedTreeFacts,
  type ParsedNpmManifest,
} from '@/lib/manifest-discovery';
import { scanPythonDeps } from './python';
import { scanGoDeps } from './go';
import { scanJavaDeps } from './java';
import { scanRustDeps } from './rust';
import { scanPhpDeps } from './php';

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
  branch?: string,
): Promise<DepAgeScanResult> {
  // Check ecosystem and dispatch to the correct scanner
  const ecosystemInfo = await detectEcosystem(accessToken, owner, repo, branch);
  if (!ecosystemInfo.supported && ecosystemInfo.ecosystem !== 'unknown') {
    return {
      ...buildResult([]),
      unsupportedEcosystem: {
        ecosystem: ecosystemInfo.ecosystem,
        label: getEcosystemLabel(ecosystemInfo.ecosystem),
      },
    };
  }

  // Dispatch to ecosystem-specific scanners, passing every discovered manifest
  // path of the primary ecosystem so monorepos union all module deps.
  if (ecosystemInfo.ecosystem === 'python') return buildResult(await scanPythonDeps(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'go') return buildResult(await scanGoDeps(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'java') return buildResult(await scanJavaDeps(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'rust') return buildResult(await scanRustDeps(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'php') return buildResult(await scanPhpDeps(accessToken, owner, repo, ecosystemInfo.manifestPaths));

  // Default: npm. Read every discovered manifest (root + workspaces / monorepo
  // packages) and union their dependencies.
  const octokit = createGitHubClient(accessToken);
  const deps: DependencyInfo[] = [];

  const manifestPaths = ecosystemInfo.manifestPaths.length > 0
    ? ecosystemInfo.manifestPaths
    : ['package.json'];

  const manifestFiles: FetchedManifest[] = [];
  const manifests = await fetchNpmManifests(octokit, owner, repo, manifestPaths, manifestFiles);
  if (manifests.length === 0) return buildResult([]);

  // Combine prod + dev deps across all manifests, dropping workspace-internal refs.
  const allDeps = unionNpmDeps(manifests);

  // Per name, today's floor strip or the version each declaring project's own
  // lockfile proves (see `resolveNpmReportVersions`).
  const reportVersions = await resolveNpmReportVersions(octokit, owner, repo, manifestPaths, {
    manifests,
    manifestFiles,
    observedLockfilePaths: ecosystemInfo.observedLockfilePaths,
    observedTreeFacts: ecosystemInfo.observedTreeFacts,
  });

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
            deps.push(makeUnknownDep(name, versionSpec, reportVersions.get(name)));
            return;
          }

          const data = await resp.json() as NpmPackageData;
          const latestVersion = data['dist-tags']?.latest ?? '';
          const isDeprecated = Boolean(data.deprecated);

          // Get publish date for the installed version: the version the
          // lockfiles prove when the row is raised, else the manifest floor
          // (leading range operator stripped).
          const cleanInstalled = reportedVersion(versionSpec, reportVersions.get(name));
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
          deps.push(makeUnknownDep(name, versionSpec, reportVersions.get(name)));
        }
      }),
    );
  }

  return buildResult(deps);
}

/** The row's version: the raised one when the proof holds, else the floor strip. */
function reportedVersion(versionSpec: string, row: NpmReportVersion | undefined): string {
  if (row) return row.raisedTo ?? row.strip;
  return versionSpec.replace(/^[^0-9]*/, '');
}

/**
 * Per package name, what the CVE scan's narrow proof (`collectNpmReportVersions`
 * in lib/cve/osv.ts) allows the report to show above the manifest floor. The
 * row stays at the floor strip of the spec (the report as it was) unless every
 * declaration of the package is in `dependencies` or `devDependencies`, every
 * project declaring it has its own package-lock.json and each of them proves
 * the version its top-level entry installs for that declaration; then it is
 * the lowest of those versions. So the row rises above the manifest floor only
 * where each declaring project's own lockfile proves a higher version and no
 * lockfile installs the floor. A declaration in `optionalDependencies`,
 * `peerDependencies` or `bundleDependencies` (the row is raised only from
 * `dependencies` and `devDependencies` declarations), yarn-only repositories, lockfileVersion 1, workspaces, an unreadable or
 * stale lockfile, an `.npmrc` and partially locked repositories keep the
 * floor. A copy installed only as a dependency of another package (nested,
 * or hoisted in a project that does not declare it) is not reflected in the
 * row; a copy of the floor anywhere keeps the floor.
 * Never throws: a failed resolution leaves the map empty (every name keeps the
 * floor strip) and is reported as a degraded source.
 */
async function resolveNpmReportVersions(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  manifestPaths: string[],
  fetched: {
    manifests: ParsedNpmManifest[];
    manifestFiles: FetchedManifest[];
    observedLockfilePaths: { npm: string[]; yarn: string[] } | null | undefined;
    observedTreeFacts: ObservedTreeFacts | null | undefined;
  },
): Promise<Map<string, NpmReportVersion>> {
  try {
    const rows = await collectNpmReportVersions(
      octokit,
      owner,
      repo,
      manifestPaths,
      fetched.observedLockfilePaths,
      fetched.observedTreeFacts,
      { manifests: fetched.manifests, manifestFiles: fetched.manifestFiles },
    );
    return new Map(rows.map((row) => [row.name, row]));
  } catch (err) {
    noteDegraded('npm lockfile resolution', err);
    return new Map();
  }
}

function makeUnknownDep(
  name: string,
  versionSpec: string,
  row?: NpmReportVersion,
): DependencyInfo {
  return {
    name,
    installedVersion: row?.raisedTo ?? (versionSpec.replace(/^[^0-9]*/, '') || versionSpec),
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
