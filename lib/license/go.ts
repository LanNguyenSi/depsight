import { createGitHubClient } from '@/lib/github';
import { collectGoDeps } from '@/lib/manifests/go';
import type { LicenseEntry } from './detector';

/**
 * Scan Go module licenses across all discovered go.mod manifests (root +
 * workspace modules).
 *
 * Documented limitation: Go module license detection is unreliable without
 * HTML scraping of pkg.go.dev or similar services. All packages are returned
 * with license: 'UNKNOWN' and needsReview: true for manual review.
 */
export async function scanGoLicenses(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);

  // Read every discovered go.mod and union the required modules (repo-local
  // modules filtered out).
  const modules = await collectGoDeps(octokit, owner, repo, manifestPaths);

  // For Go packages, license detection requires scraping pkg.go.dev or
  // inspecting the source repository directly. Without that, we mark all
  // entries as UNKNOWN and flag them for manual review.
  return modules.map((mod): LicenseEntry => ({
    packageName: mod.name,
    version: mod.version,
    license: 'UNKNOWN',
    isCompatible: true,
    policyViolation: false,
    needsReview: true,
  }));
}
