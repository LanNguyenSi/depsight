import { createGitHubClient } from '@/lib/github';
import { collectPhpDeps } from '@/lib/manifests/php';
import type { LicenseEntry } from './detector';

interface PackagistVersionEntry {
  version: string;
  license?: string[];
}

interface PackagistData {
  packages: Record<string, PackagistVersionEntry[]>;
}

const COPYLEFT_LICENSES = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0',
  'MPL-2.0', 'EUPL-1.1', 'EUPL-1.2',
  'CDDL-1.0', 'CDDL-1.1',
  'OSL-3.0', 'EPL-1.0', 'EPL-2.0',
]);

function classifyLicense(license: string): { isCompatible: boolean; policyViolation: boolean; needsReview: boolean } {
  const normalized = license.trim().toUpperCase();

  for (const l of COPYLEFT_LICENSES) {
    if (normalized === l.toUpperCase()) {
      return { isCompatible: false, policyViolation: true, needsReview: false };
    }
  }

  if (normalized === 'UNKNOWN' || normalized === '' || normalized === 'UNLICENSED') {
    return { isCompatible: true, policyViolation: false, needsReview: true };
  }

  return { isCompatible: true, policyViolation: false, needsReview: false };
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
