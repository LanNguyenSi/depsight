import { createGitHubClient } from '@/lib/github';
import { getEcosystemLabel, type Ecosystem } from '@/lib/ecosystem';
import {
  detectEcosystem,
  fetchNpmManifests,
  unionNpmDeps,
} from '@/lib/manifest-discovery';
import { scanPythonLicenses } from './python';
import { scanGoLicenses } from './go';
import { scanJavaLicenses } from './java';
import { scanRustLicenses } from './rust';
import { scanPhpLicenses } from './php';

export interface LicenseEntry {
  packageName: string;
  version: string;
  license: string;
  isCompatible: boolean;
  policyViolation: boolean;
  needsReview: boolean; // true when license is unknown/undetected (not necessarily a violation)
}

export interface LicenseScanResult {
  licenses: LicenseEntry[];
  summary: Record<string, number>; // license -> count
  hasConflicts: boolean;
  conflictCount: number;
  unsupportedEcosystem?: { ecosystem: Ecosystem; label: string };
}

// Copyleft licenses that conflict with proprietary use
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

  // Check exact copyleft match
  for (const l of COPYLEFT_LICENSES) {
    if (normalized === l.toUpperCase()) {
      return { isCompatible: false, policyViolation: true, needsReview: false };
    }
  }

  // Unknown / custom licenses — not a violation, but needs manual review
  if (
    normalized === 'UNKNOWN' ||
    normalized === '' ||
    normalized === 'SEE LICENSE IN LICENSE' ||
    normalized === 'UNLICENSED'
  ) {
    return { isCompatible: true, policyViolation: false, needsReview: true };
  }

  return { isCompatible: true, policyViolation: false, needsReview: false };
}

export async function detectLicenses(
  accessToken: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<LicenseScanResult> {
  const octokit = createGitHubClient(accessToken);
  const licenses: LicenseEntry[] = [];

  // Check ecosystem and dispatch to the correct scanner
  const ecosystemInfo = await detectEcosystem(accessToken, owner, repo, branch);
  if (!ecosystemInfo.supported && ecosystemInfo.ecosystem !== 'unknown') {
    return {
      ...buildLicenseScanResult([]),
      unsupportedEcosystem: {
        ecosystem: ecosystemInfo.ecosystem,
        label: getEcosystemLabel(ecosystemInfo.ecosystem),
      },
    };
  }

  // Dispatch to ecosystem-specific scanners, passing every discovered manifest
  // path of the primary ecosystem so monorepos union all module licenses.
  if (ecosystemInfo.ecosystem === 'python') return buildLicenseScanResult(await scanPythonLicenses(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'go') return buildLicenseScanResult(await scanGoLicenses(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'java') return buildLicenseScanResult(await scanJavaLicenses(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'rust') return buildLicenseScanResult(await scanRustLicenses(accessToken, owner, repo, ecosystemInfo.manifestPaths));
  if (ecosystemInfo.ecosystem === 'php') return buildLicenseScanResult(await scanPhpLicenses(accessToken, owner, repo, ecosystemInfo.manifestPaths));

  // Default: npm
  try {
    // 1. Get repo-level license via GitHub API
    let repoLicense = 'UNKNOWN';
    try {
      const licenseResp = await octokit.rest.licenses.getForRepo({ owner, repo });
      repoLicense = licenseResp.data.license?.spdx_id ?? 'UNKNOWN';
    } catch {
      // No license file found
    }

    // 2. Read every discovered manifest (root + workspaces / monorepo packages)
    //    and union their dependencies into the list to resolve.
    const manifestPaths = ecosystemInfo.manifestPaths.length > 0
      ? ecosystemInfo.manifestPaths
      : ['package.json'];
    const manifests = await fetchNpmManifests(octokit, owner, repo, manifestPaths);

    if (manifests.length > 0) {
      const depEntries: LicenseEntry[] = unionNpmDeps(manifests).map((d) => ({
        packageName: d.name,
        version: d.versionSpec,
        license: 'UNKNOWN',
        isCompatible: true,
        policyViolation: false,
        needsReview: true,
      }));

      // 3. Fetch npm registry metadata for each dep to get actual license
      const BATCH_SIZE = 10;
      for (let i = 0; i < depEntries.length; i += BATCH_SIZE) {
        const batch = depEntries.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (entry) => {
            try {
              const response = await fetch(
                `https://registry.npmjs.org/${encodeURIComponent(entry.packageName)}/latest`,
                { headers: { Accept: 'application/json' } },
              );
              if (response.ok) {
                const data = await response.json() as { license?: string };
                const detectedLicense = data.license ?? 'UNKNOWN';
                const classification = classifyLicense(detectedLicense);
                licenses.push({
                  ...entry,
                  license: detectedLicense,
                  ...classification,
                });
              } else {
                licenses.push({ ...entry, needsReview: true });
              }
            } catch {
              licenses.push({ ...entry, needsReview: true });
            }
          }),
        );
      }
    }

    // Add repo-level license as an entry
    if (repoLicense !== 'UNKNOWN') {
      const classification = classifyLicense(repoLicense);
      licenses.push({
        packageName: `${owner}/${repo}`,
        version: 'main',
        license: repoLicense,
        ...classification,
      });
    }
  } catch (error: unknown) {
    const err = error as { status?: number };
    if (err?.status === 404 || err?.status === 403) {
      return buildLicenseScanResult([]);
    }
    throw error;
  }

  return buildLicenseScanResult(licenses);
}

function buildLicenseScanResult(licenses: LicenseEntry[]): LicenseScanResult {
  const summary: Record<string, number> = {};
  for (const entry of licenses) {
    summary[entry.license] = (summary[entry.license] ?? 0) + 1;
  }

  // Only count real policy violations as conflicts (not unknown/needs-review)
  const conflicts = licenses.filter((l) => l.policyViolation);

  return {
    licenses,
    summary,
    hasConflicts: conflicts.length > 0,
    conflictCount: conflicts.length,
  };
}
