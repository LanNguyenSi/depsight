import { createGitHubClient } from '@/lib/github';
import { collectRustDeps } from '@/lib/manifests/rust';
import type { LicenseEntry } from './detector';
import { classifyLicense, type LicenseClassification } from './classifier';

interface CrateVersion {
  num: string;
  license: string;
  yanked: boolean;
}

interface CrateData {
  versions: CrateVersion[];
}

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

/** A dual-license expression is reduced to its most permissive part before the shared classifier runs. */
function resolveRustLicense(spdxExpression: string): { license: string; classification: LicenseClassification } {
  const license = selectMostPermissive(spdxExpression);
  return { license, classification: classifyLicense(license) };
}

export function classifyRustLicense(spdxExpression: string): LicenseClassification {
  return resolveRustLicense(spdxExpression).classification;
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
          const resolved = resolveRustLicense(spdxLicense);

          licenses.push({
            packageName: name,
            version,
            license: resolved.license,
            ...resolved.classification,
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
