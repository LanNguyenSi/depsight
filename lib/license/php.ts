import { createGitHubClient } from '@/lib/github';
import { collectPhpDeps } from '@/lib/manifests/php';
import type { LicenseEntry } from './detector';
import { classifyLicense } from './classifier';

interface PackagistVersionEntry {
  version: string;
  license?: string[];
}

interface PackagistData {
  packages: Record<string, PackagistVersionEntry[]>;
}

/**
 * Scan PHP package licenses across all discovered composer.json manifests
 * (root + monorepo packages) via the Packagist registry.
 */
export async function scanPhpLicenses(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);
  const licenses: LicenseEntry[] = [];

  const parsedDeps = await collectPhpDeps(octokit, owner, repo, manifestPaths);
  if (parsedDeps.length === 0) return [];

  const BATCH_SIZE = 10;

  for (let i = 0; i < parsedDeps.length; i += BATCH_SIZE) {
    const batch = parsedDeps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ name, version }) => {
        try {
          const resp = await fetch(
            `https://repo.packagist.org/p2/${name}.json`,
            { headers: { Accept: 'application/json' } },
          );
          if (!resp.ok) {
            licenses.push({
              packageName: name,
              version,
              license: 'UNKNOWN',
              isCompatible: true,
              policyViolation: false,
              needsReview: true,
            });
            return;
          }

          const data = (await resp.json()) as PackagistData;
          const packageVersions = data.packages[name];
          if (!packageVersions || packageVersions.length === 0) {
            licenses.push({
              packageName: name,
              version,
              license: 'UNKNOWN',
              isCompatible: true,
              policyViolation: false,
              needsReview: true,
            });
            return;
          }

          // License from the latest version entry (first in array)
          const licenseArray = packageVersions[0].license;
          const detectedLicense = licenseArray && licenseArray.length > 0
            ? licenseArray[0]
            : 'UNKNOWN';
          const classification = classifyLicense(detectedLicense);

          licenses.push({
            packageName: name,
            version,
            license: detectedLicense,
            ...classification,
          });
        } catch {
          licenses.push({
            packageName: name,
            version,
            license: 'UNKNOWN',
            isCompatible: true,
            policyViolation: false,
            needsReview: true,
          });
        }
      }),
    );
  }

  return licenses;
}
