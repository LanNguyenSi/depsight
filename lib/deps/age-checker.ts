import semver from 'semver';
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
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
  deprecated?: string;
  'dist-tags'?: {
    latest?: string;
  };
}

/**
 * The version the report compares against. Normally `dist-tags.latest`. When
 * that tag points at a prerelease (a package can publish its next major as an
 * `rc` under `latest`), the newest stable release in the packument is used
 * instead: the highest non-prerelease version among the `versions` keys, or,
 * when the packument has no `versions` map, among the `time` keys (`time` keeps
 * unpublished versions, and `created` and `modified` are not versions). When
 * the packument holds no stable version, or the tag is not a semver version at
 * all, the tag stays.
 */
export function pickLatestVersion(data: NpmPackageData): string {
  const tagged = data['dist-tags']?.latest ?? '';
  if (!tagged || semver.valid(tagged) === null || semver.prerelease(tagged) === null) return tagged;
  // `versions` lists what is published. `time` keeps unpublished versions (and
  // `created`, `modified`), so it is read only when the packument has no `versions` map.
  const versions = data.versions;
  const candidates =
    typeof versions === 'object' && versions !== null && !Array.isArray(versions)
      ? Object.keys(versions)
      : Object.keys(data.time ?? {});
  let best: string | null = null;
  for (const candidate of candidates) {
    if (semver.valid(candidate) === null || semver.prerelease(candidate) !== null) continue;
    if (best === null || semver.gt(candidate, best)) best = candidate;
  }
  return best ?? tagged;
}

// A numeric prefix of a floor strip: `8`, `8.1`, `1.x`, `7.3.5 <8`, `1.2.3||2`.
// Digits inside a git, URL or file spec (`2#main`, `1.2.3.tgz`) are not one.
const PARTIAL_VERSION = /^\d+(\.(\d+|x|X|\*)){0,2}(?=\s|\||$)/;

// A version string as a SemVer: a full version as it is (a prerelease keeps its
// tag, so 7.3.5-beta.2 sorts below 7.3.5), else the first x.y.z of a partial
// numeric strip (`8` gives 8.0.0, `7.3.5 <8` gives 7.3.5), else null: a string
// that is no version has no status.
function toSemver(v: string): semver.SemVer | null {
  const text = v.trim();
  return semver.parse(text) ?? (PARTIAL_VERSION.test(text) ? semver.coerce(text) : null);
}

export function classifyStatus(
  installed: string,
  latest: string,
  isDeprecated: boolean,
): DependencyStatus {
  if (isDeprecated) return 'DEPRECATED';
  if (!installed || installed === 'unknown' || !latest) return 'UNKNOWN';

  const i = toSemver(installed);
  const l = toSemver(latest);
  if (i === null || l === null) return 'UNKNOWN';
  if (i.major < l.major) return 'MAJOR_BEHIND';
  if (semver.lt(i, l)) return 'OUTDATED';
  return 'UP_TO_DATE';
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
          const latestVersion = pickLatestVersion(data);
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
 * declaration of the package is in `dependencies` or `devDependencies`, the
 * lockfile that installs each declarer (its own package-lock.json, or the
 * workspace root's for a member that root's lockfile proves) is present and
 * proves the version its top-level entry installs for that declaration; then
 * it is the lowest of those versions. So the row rises above the manifest
 * floor only where each declarer's installing lockfile proves a higher version
 * and no lockfile installs the floor. A declaration in `optionalDependencies`,
 * `peerDependencies` or `bundleDependencies` (the row is raised only from
 * `dependencies` and `devDependencies` declarations), yarn-only repositories,
 * lockfileVersion 1, a workspace whose root lockfile does not prove the
 * declarer, an unreadable or stale lockfile, an `.npmrc` and partially locked
 * repositories keep the floor. A copy installed only as a dependency of another package (nested,
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
      // The report reads the proof without the CVE scan's `overrides` block.
      { overridesDoNotBlock: true },
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
