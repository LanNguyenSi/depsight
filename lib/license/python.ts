import { createGitHubClient } from '@/lib/github';
import { collectPythonDeps } from '@/lib/manifests/python';
import type { LicenseEntry } from './detector';

interface PyPIPackageInfo {
  info?: {
    version?: string;
    license?: string;
  };
}

// Copyleft-Lizenzen, die mit proprietaerer Nutzung kollidieren
const COPYLEFT_LICENSES = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later',
  'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0',
  'MPL-2.0', 'EUPL-1.1', 'EUPL-1.2',
  'CDDL-1.0', 'CDDL-1.1',
  'OSL-3.0', 'EPL-1.0', 'EPL-2.0',
]);

/**
 * Normalize common Python license strings to SPDX identifiers.
 * PyPI packages often use free-text license names instead of SPDX.
 */
function normalizeLicense(raw: string): string {
  if (!raw || raw.trim() === '') return 'UNKNOWN';

  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();

  // Direct SPDX-like match — return as-is (trimmed)
  if (COPYLEFT_LICENSES.has(trimmed)) return trimmed;

  // Common free-text variants used in PyPI
  const LICENSE_MAP: Record<string, string> = {
    'MIT LICENSE': 'MIT',
    'MIT': 'MIT',
    'THE MIT LICENSE': 'MIT',
    'BSD LICENSE': 'BSD-3-Clause',
    'BSD': 'BSD-3-Clause',
    'BSD-2-CLAUSE': 'BSD-2-Clause',
    'BSD 2-CLAUSE LICENSE': 'BSD-2-Clause',
    'BSD-3-CLAUSE': 'BSD-3-Clause',
    'BSD 3-CLAUSE LICENSE': 'BSD-3-Clause',
    'APACHE LICENSE 2.0': 'Apache-2.0',
    'APACHE LICENSE, VERSION 2.0': 'Apache-2.0',
    'APACHE 2.0': 'Apache-2.0',
    'APACHE-2.0': 'Apache-2.0',
    'APACHE SOFTWARE LICENSE': 'Apache-2.0',
    'APACHE': 'Apache-2.0',
    'ISC LICENSE': 'ISC',
    'ISC LICENSE (ISCL)': 'ISC',
    'ISC': 'ISC',
    'MOZILLA PUBLIC LICENSE 2.0 (MPL 2.0)': 'MPL-2.0',
    'MPL 2.0': 'MPL-2.0',
    'MPL-2.0': 'MPL-2.0',
    'GNU GENERAL PUBLIC LICENSE V3 (GPLV3)': 'GPL-3.0',
    'GNU GENERAL PUBLIC LICENSE V3': 'GPL-3.0',
    'GPLV3': 'GPL-3.0',
    'GPL-3.0': 'GPL-3.0',
    'GNU GENERAL PUBLIC LICENSE V2 (GPLV2)': 'GPL-2.0',
    'GNU GENERAL PUBLIC LICENSE V2': 'GPL-2.0',
    'GPLV2': 'GPL-2.0',
    'GPL-2.0': 'GPL-2.0',
    'GNU LESSER GENERAL PUBLIC LICENSE V3 (LGPLV3)': 'LGPL-3.0',
    'LGPLV3': 'LGPL-3.0',
    'LGPL-3.0': 'LGPL-3.0',
    'GNU LESSER GENERAL PUBLIC LICENSE V2 (LGPLV2)': 'LGPL-2.1',
    'LGPLV2': 'LGPL-2.1',
    'LGPL-2.1': 'LGPL-2.1',
    'GNU AFFERO GENERAL PUBLIC LICENSE V3': 'AGPL-3.0',
    'AGPLV3': 'AGPL-3.0',
    'AGPL-3.0': 'AGPL-3.0',
    'PYTHON SOFTWARE FOUNDATION LICENSE': 'PSF-2.0',
    'PSF': 'PSF-2.0',
    'PUBLIC DOMAIN': 'Unlicense',
    'UNLICENSE': 'Unlicense',
    'THE UNLICENSE': 'Unlicense',
    'ECLIPSE PUBLIC LICENSE 2.0': 'EPL-2.0',
    'EPL-2.0': 'EPL-2.0',
  };

  return LICENSE_MAP[upper] ?? trimmed;
}

function classifyLicense(license: string): { isCompatible: boolean; policyViolation: boolean; needsReview: boolean } {
  const normalized = license.trim().toUpperCase();

  // Exakte Copyleft-Pruefung
  for (const l of COPYLEFT_LICENSES) {
    if (normalized === l.toUpperCase()) {
      return { isCompatible: false, policyViolation: true, needsReview: false };
    }
  }

  // Unbekannte / benutzerdefinierte Lizenzen — kein Verstoss, aber manuelle Pruefung noetig
  if (
    normalized === 'UNKNOWN' ||
    normalized === '' ||
    normalized === 'UNLICENSED'
  ) {
    return { isCompatible: true, policyViolation: false, needsReview: true };
  }

  return { isCompatible: true, policyViolation: false, needsReview: false };
}

/**
 * Scannt Python-Abhaengigkeiten ueber alle entdeckten Manifeste (pyproject.toml
 * / requirements.txt; Monorepo-Module eingeschlossen) und ermittelt die
 * Lizenzinformationen ueber die PyPI-Registry.
 */
export async function scanPythonLicenses(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);
  const licenses: LicenseEntry[] = [];

  const parsedDeps = await collectPythonDeps(octokit, owner, repo, manifestPaths);
  if (parsedDeps.length === 0) return [];

  // PyPI-Registry-Abfragen in Batches
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 50;

  for (let i = 0; i < parsedDeps.length; i += BATCH_SIZE) {
    if (i > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    const batch = parsedDeps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ name, version }) => {
        try {
          const resp = await fetch(
            `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
            { headers: { Accept: 'application/json' } },
          );
          if (!resp.ok) {
            licenses.push({
              packageName: name,
              version: version || 'unknown',
              license: 'UNKNOWN',
              isCompatible: true,
              policyViolation: false,
              needsReview: true,
            });
            return;
          }

          const data = (await resp.json()) as PyPIPackageInfo;
          const rawLicense = data.info?.license ?? '';
          const normalizedLicense = normalizeLicense(rawLicense);
          const classification = classifyLicense(normalizedLicense);

          licenses.push({
            packageName: name,
            version: version || (data.info?.version ?? 'unknown'),
            license: normalizedLicense,
            ...classification,
          });
        } catch {
          licenses.push({
            packageName: name,
            version: version || 'unknown',
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
