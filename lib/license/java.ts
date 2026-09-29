import { createGitHubClient } from '@/lib/github';
import { collectJavaDeps } from '@/lib/manifests/java';
import type { LicenseEntry } from './detector';
import {
  COPYLEFT_CLASSIFICATION,
  classifyLicense,
  type LicenseClassification,
} from './classifier';

// Map common non-SPDX license names to copyleft detection
const COPYLEFT_NAME_PATTERNS: ReadonlyArray<string> = [
  'GNU General Public License',
  'GNU Lesser General Public License',
  'GNU Affero General Public License',
  'GNU GPL',
  'GNU LGPL',
  'GNU AGPL',
  'GPL v2', 'GPL v3', 'GPLv2', 'GPLv3',
  'Mozilla Public License',
  'Common Development and Distribution License',
  'Eclipse Public License',
  'European Union Public License',
  'Open Software License',
];

/**
 * Maven <license> blocks often carry a human-readable name rather than an SPDX
 * id, so a full-name substring match runs before the shared classifier.
 */
export function classifyJavaLicense(license: string): LicenseClassification {
  const upper = license.trim().toUpperCase();
  if (COPYLEFT_NAME_PATTERNS.some((pattern) => upper.includes(pattern.toUpperCase()))) {
    return { ...COPYLEFT_CLASSIFICATION };
  }
  return classifyLicense(license);
}

function parseLicenseFromPom(pomXml: string): string {
  // Match <licenses><license><name>...</name></license></licenses>
  const licensesBlockMatch = /<licenses>([\s\S]*?)<\/licenses>/.exec(pomXml);
  if (!licensesBlockMatch) return 'UNKNOWN';

  const nameMatch = /<license>[\s\S]*?<name>\s*(.*?)\s*<\/name>[\s\S]*?<\/license>/.exec(
    licensesBlockMatch[1],
  );
  return nameMatch ? nameMatch[1] : 'UNKNOWN';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scanJavaLicenses(
  accessToken: string,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);
  const results: LicenseEntry[] = [];

  // 1. Read every discovered pom.xml (root + reactor modules) and union deps.
  const deps = await collectJavaDeps(octokit, owner, repo, manifestPaths);
  if (deps.length === 0) return [];

  // 2. Fetch license info from Maven Central POMs in batches
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 50;

  for (let i = 0; i < deps.length; i += BATCH_SIZE) {
    if (i > 0) await delay(BATCH_DELAY_MS);

    const batch = deps.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (dep) => {
        const packageName = `${dep.groupId}:${dep.artifactId}`;

        try {
          // groupPath: replace '.' with '/' in groupId
          const groupPath = dep.groupId.replace(/\./g, '/');
          const pomUrl = `https://repo1.maven.org/maven2/${groupPath}/${dep.artifactId}/${dep.version}/${dep.artifactId}-${dep.version}.pom`;

          const resp = await fetch(pomUrl, {
            headers: { Accept: 'application/xml' },
          });

          if (!resp.ok) {
            results.push({
              packageName,
              version: dep.version,
              license: 'UNKNOWN',
              isCompatible: true,
              policyViolation: false,
              needsReview: true,
            });
            return;
          }

          const pomXml = await resp.text();
          const licenseName = parseLicenseFromPom(pomXml);
          const classification = classifyJavaLicense(licenseName);

          results.push({
            packageName,
            version: dep.version,
            license: licenseName,
            ...classification,
          });
        } catch {
          results.push({
            packageName,
            version: dep.version,
            license: 'UNKNOWN',
            isCompatible: true,
            policyViolation: false,
            needsReview: true,
          });
        }
      }),
    );
  }

  return results;
}
