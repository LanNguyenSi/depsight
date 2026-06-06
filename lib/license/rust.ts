import { createGitHubClient } from '@/lib/github';
import { collectRustDeps } from '@/lib/manifests/rust';
import type { LicenseEntry } from './detector';

interface CrateVersion {
  num: string;
  license: string;
  yanked: boolean;
}

interface CrateData {
  versions: CrateVersion[];
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

// Permissive licenses ranked by permissiveness (most permissive first)
const PERMISSIVE_RANK: Record<string, number> = {
  'MIT': 1,
  'Unlicense': 2,
  '0BSD': 3,
  'ISC': 4,
  'BSD-2-Clause': 5,
  'BSD-3-Clause': 6,
  'Apache-2.0': 7,
  'Zlib': 8,
};

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
 * For dual licenses like "MIT OR Apache-2.0", pick the most permissive one.
 */
function selectMostPermissive(spdxExpression: string): string {
  if (!spdxExpression.includes(' OR ')) return spdxExpression.trim();

  const parts = spdxExpression.split(' OR ').map((s) => s.trim());
  let best = parts[0];
  let bestRank = PERMISSIVE_RANK[best] ?? 999;

  for (let i = 1; i < parts.length; i++) {
    const rank = PERMISSIVE_RANK[parts[i]] ?? 999;
    if (rank < bestRank) {
      best = parts[i];
      bestRank = rank;
    }
  }

  return best;
}

/**
 * Scan Rust crate licenses across all discovered Cargo.toml manifests
 * (workspace root + member crates) via the crates.io registry.
 */
export async function scanRustLicenses(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);
  const licenses: LicenseEntry[] = [];

  const parsedDeps = await collectRustDeps(octokit, owner, repo, manifestPaths);
  if (parsedDeps.length === 0) return [];

  const BATCH_SIZE = 10;

  for (let i = 0; i < parsedDeps.length; i += BATCH_SIZE) {
    const batch = parsedDeps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ name, version }) => {
        try {
          const resp = await fetch(
            `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
            {
              headers: {
                Accept: 'application/json',
                'User-Agent': 'depsight/1.0 (https://github.com/depsight)',
              },
            },
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

          const data = (await resp.json()) as CrateData;
          const latestVersion = data.versions.length > 0 ? data.versions[0] : undefined;
          const spdxLicense = latestVersion?.license ?? 'UNKNOWN';
          const effectiveLicense = selectMostPermissive(spdxLicense);
          const classification = classifyLicense(effectiveLicense);

          licenses.push({
            packageName: name,
            version,
            license: effectiveLicense,
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
