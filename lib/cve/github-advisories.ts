import { createGitHubClient } from '@/lib/github';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface GitHubAdvisory {
  ghsaId: string;
  cveId: string | null;
  severity: Severity;
  summary: string;
  packageName: string;
  ecosystem: string;
  vulnerableRange: string | null;
  fixedVersion: string | null;
  publishedAt: Date | null;
  url: string | null;
}

export interface ScanResult {
  advisories: GitHubAdvisory[];
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
    total: number;
  };
  riskScore: number;
}

function normalizeSeverity(severity: string | null | undefined): Severity {
  const s = (severity ?? '').toUpperCase();
  if (s === 'CRITICAL') return 'CRITICAL';
  if (s === 'HIGH') return 'HIGH';
  if (s === 'MEDIUM' || s === 'MODERATE') return 'MEDIUM';
  if (s === 'LOW') return 'LOW';
  return 'UNKNOWN';
}

function calculateRiskScore(counts: ScanResult['counts']): number {
  // Weighted risk score 0–100
  const score =
    counts.critical * 10 +
    counts.high * 5 +
    counts.medium * 2 +
    counts.low * 0.5;
  return Math.min(100, Math.round(score));
}

export interface ScanResultWithStatus extends ScanResult {
  dependabotDisabled?: boolean;
}

export async function enableDependabotAlerts(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  const octokit = createGitHubClient(accessToken);
  try {
    await octokit.rest.repos.enableVulnerabilityAlerts({ owner, repo });
    return true;
  } catch {
    return false;
  }
}

export async function fetchRepoAdvisories(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<ScanResultWithStatus> {
  const octokit = createGitHubClient(accessToken);
  const advisories: GitHubAdvisory[] = [];

  try {
    // Primary: GitHub Dependabot Alerts
    const response = await octokit.rest.dependabot.listAlertsForRepo({
      owner,
      repo,
      per_page: 100,
      state: 'open',
    });

    for (const alert of response.data as unknown as VulnerabilityAlert[]) {
      const advisory = alert.security_advisory;
      const vuln = alert.security_vulnerability;

      advisories.push({
        ghsaId: advisory.ghsa_id,
        cveId: advisory.cve_id ?? null,
        severity: normalizeSeverity(advisory.severity),
        summary: advisory.summary,
        packageName: vuln?.package?.name ?? 'unknown',
        ecosystem: vuln?.package?.ecosystem ?? 'unknown',
        vulnerableRange: vuln?.vulnerable_version_range ?? null,
        fixedVersion: vuln?.first_patched_version?.identifier ?? null,
        publishedAt: advisory.published_at ? new Date(advisory.published_at) : null,
        url: advisory.url ?? null,
      });
    }
  } catch (error: unknown) {
    const err = error as { status?: number };
    if (err?.status === 404 || err?.status === 403) {
      // Dependabot alerts not enabled — signal to caller
      return { ...buildScanResult([]), dependabotDisabled: true };
    }
    throw error;
  }

  return buildScanResult(advisories);
}

function buildScanResult(advisories: GitHubAdvisory[]): ScanResult {
  const counts = {
    critical: advisories.filter((a) => a.severity === 'CRITICAL').length,
    high: advisories.filter((a) => a.severity === 'HIGH').length,
    medium: advisories.filter((a) => a.severity === 'MEDIUM').length,
    low: advisories.filter((a) => a.severity === 'LOW').length,
    unknown: advisories.filter((a) => a.severity === 'UNKNOWN').length,
    total: advisories.length,
  };

  return {
    advisories,
    counts,
    riskScore: calculateRiskScore(counts),
  };
}

// Minimal types for the vulnerability alert response
interface VulnerabilityAlert {
  security_advisory: {
    ghsa_id: string;
    cve_id?: string;
    severity: string;
    summary: string;
    published_at?: string;
    url?: string;
  };
  security_vulnerability?: {
    package?: {
      name: string;
      ecosystem: string;
    };
    vulnerable_version_range?: string;
    first_patched_version?: {
      identifier: string;
    };
  };
}
