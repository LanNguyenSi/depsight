import type { DependencyInfo } from './age-checker';
import { createGitHubClient } from '@/lib/github';
import { collectJavaDeps, type MavenDependency } from '@/lib/manifests/java';

interface MavenSearchDoc {
  latestVersion: string;
  timestamp: number;
}

interface MavenSearchResponse {
  response: {
    docs: MavenSearchDoc[];
  };
}

function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^[^0-9]*/, '').split('.').map(Number);
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

function makeUnknownDep(dep: MavenDependency): DependencyInfo {
  return {
    name: `${dep.groupId}:${dep.artifactId}`,
    installedVersion: dep.version,
    latestVersion: '',
    publishedAt: null,
    ageInDays: -1,
    status: 'UNKNOWN',
    isDeprecated: false,
    updateAvailable: false,
    latestPublishedAt: null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scanJavaDeps(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<DependencyInfo[]> {
  const octokit = createGitHubClient(accessToken);
  const results: DependencyInfo[] = [];

  // 1. Read every discovered pom.xml (root + reactor modules) and union their
  //    declared dependencies.
  const deps = await collectJavaDeps(octokit, owner, repo, manifestPaths);
  if (deps.length === 0) return [];

  // 2. Query Maven Central for each dependency in batches
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 50;
  const now = new Date();

  for (let i = 0; i < deps.length; i += BATCH_SIZE) {
    if (i > 0) await delay(BATCH_DELAY_MS);

    const batch = deps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (dep) => {
        try {
          const url = `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(dep.groupId)}+AND+a:${encodeURIComponent(dep.artifactId)}&rows=1&wt=json`;
          const resp = await fetch(url, {
            headers: { Accept: 'application/json' },
          });

          if (!resp.ok) {
            results.push(makeUnknownDep(dep));
            return;
          }

          const data = await resp.json() as MavenSearchResponse;
          const doc = data.response.docs[0];

          if (!doc) {
            results.push(makeUnknownDep(dep));
            return;
          }

          const latestVersion = doc.latestVersion;
          const latestPublishedAt = doc.timestamp ? new Date(doc.timestamp) : null;

          const ageInDays = latestPublishedAt
            ? Math.floor((now.getTime() - latestPublishedAt.getTime()) / (1000 * 60 * 60 * 24))
            : -1;

          const status = classifyStatus(dep.version, latestVersion);

          results.push({
            name: `${dep.groupId}:${dep.artifactId}`,
            installedVersion: dep.version,
            latestVersion,
            publishedAt: latestPublishedAt,
            ageInDays,
            status,
            isDeprecated: false,
            updateAvailable: status === 'OUTDATED' || status === 'MAJOR_BEHIND',
            latestPublishedAt,
          });
        } catch {
          results.push(makeUnknownDep(dep));
        }
      }),
    );
  }

  return results;
}
