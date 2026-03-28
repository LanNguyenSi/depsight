import { createGitHubClient } from '@/lib/github';
import type { LicenseEntry } from './detector';

interface PyPIPackageInfo {
  info?: {
    version?: string;
    license?: string;
  };
}

interface ParsedDep {
  name: string;
  version: string;
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
 * Parse a pyproject.toml `dependencies` array using simple regex.
 */
function parsePyprojectToml(content: string): ParsedDep[] {
  const deps: ParsedDep[] = [];

  const depsBlockMatch = /\bdependencies\s*=\s*\[([^\]]*)\]/s.exec(content);
  if (!depsBlockMatch) return deps;

  const block = depsBlockMatch[1];
  const entryPattern = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    const raw = match[1].trim();
    parseDependencySpec(raw, deps);
  }

  return deps;
}

/**
 * Parse requirements.txt lines.
 */
function parseRequirementsTxt(content: string): ParsedDep[] {
  const deps: ParsedDep[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    parseDependencySpec(line, deps);
  }

  return deps;
}

/**
 * Parse a single dependency specifier like "requests>=2.28" into name + version.
 */
function parseDependencySpec(spec: string, deps: ParsedDep[]): void {
  const withoutMarkers = spec.split(';')[0].trim();
  const withoutExtras = withoutMarkers.replace(/\[.*?\]/, '');

  const splitMatch = /^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+)\s*(.+)$/.exec(withoutExtras);
  if (splitMatch) {
    const name = splitMatch[1].trim();
    const versionPart = splitMatch[2].split(',')[0].trim();
    deps.push({ name, version: versionPart });
  } else {
    const name = withoutExtras.trim();
    if (name) {
      deps.push({ name, version: '' });
    }
  }
}

/**
 * Scannt Python-Abhaengigkeiten (pyproject.toml oder requirements.txt) und
 * ermittelt die Lizenzinformationen ueber die PyPI-Registry.
 */
export async function scanPythonLicenses(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);
  const licenses: LicenseEntry[] = [];
  let parsedDeps: ParsedDep[] = [];

  // Versuche pyproject.toml, Fallback auf requirements.txt
  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'pyproject.toml' });
    if ('content' in fileResp.data) {
      const content = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
      parsedDeps = parsePyprojectToml(content);
    }
  } catch {
    // pyproject.toml nicht gefunden
  }

  if (parsedDeps.length === 0) {
    try {
      const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'requirements.txt' });
      if ('content' in fileResp.data) {
        const content = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
        parsedDeps = parseRequirementsTxt(content);
      }
    } catch {
      // Keine Python-Manifestdatei gefunden
      return [];
    }
  }

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
