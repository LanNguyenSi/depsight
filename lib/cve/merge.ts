import type { GitHubAdvisory } from './github-advisories';

/**
 * Merge Dependabot and OSV advisories, deduplicating by (identifier, packageName).
 *
 * Rules:
 * - Dependabot advisories are kept, except that a second alert for the same
 *   (ghsaId, packageName) collapses into the first: Dependabot raises one alert
 *   per manifest, so a monorepo reports the same advisory and package several
 *   times, and the Advisory table holds one row per (scan, ghsaId, packageName).
 * - OSV advisories are kept only if neither their (ghsaId, packageName) nor
 *   (cveId, packageName) pair is already covered by a dependabot advisory or
 *   a previously-kept OSV advisory.
 * - GHSA-bearing OSV advisories are processed first so the canonical record
 *   wins over alias twins (e.g. PYSEC-/GO-/RUSTSEC- with the same CVE and package).
 */
export function mergeCveAdvisories(
  dependabot: GitHubAdvisory[],
  osv: GitHubAdvisory[],
): GitHubAdvisory[] {
  // Collapse repeated Dependabot alerts for one advisory and package (first wins)
  const seenDependabot = new Set<string>();
  const uniqueDependabot = dependabot.filter((a) => {
    const key = `${a.ghsaId} ${a.packageName}`;
    if (seenDependabot.has(key)) return false;
    seenDependabot.add(key);
    return true;
  });

  // Seed covered keys from all Dependabot advisories keyed by (identifier, packageName)
  const covered = new Set<string>();
  for (const a of uniqueDependabot) {
    covered.add(`${a.ghsaId} ${a.packageName}`);
    if (a.cveId) covered.add(`${a.cveId} ${a.packageName}`);
  }

  // Sort OSV so GHSA-bearing records come first (canonical record wins over alias twin)
  const sortedOsv = [...osv].sort((a, b) => {
    const aIsGhsa = a.ghsaId.startsWith('GHSA-') ? 0 : 1;
    const bIsGhsa = b.ghsaId.startsWith('GHSA-') ? 0 : 1;
    return aIsGhsa - bIsGhsa;
  });

  const keptOsv: GitHubAdvisory[] = [];
  for (const a of sortedOsv) {
    const candidateKeys: string[] = [
      `${a.ghsaId} ${a.packageName}`,
      ...(a.cveId ? [`${a.cveId} ${a.packageName}`] : []),
    ];

    // Skip if any candidate key is already covered (duplicates Dependabot or a kept OSV row)
    if (candidateKeys.some((k) => covered.has(k))) continue;

    // Keep this advisory and mark all its candidate keys as covered so alias twins are skipped
    keptOsv.push(a);
    for (const k of candidateKeys) covered.add(k);
  }

  return [...uniqueDependabot, ...keptOsv];
}
