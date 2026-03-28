import type { LicenseEntry } from './detector';
import { createGitHubClient } from '@/lib/github';

interface MavenDependency {
  groupId: string;
  artifactId: string;
  version: string;
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

function classifyLicense(license: string): { isCompatible: boolean; policyViolation: boolean; needsReview: boolean } {
  const normalized = license.trim().toUpperCase();

  // Check exact SPDX copyleft match
  for (const l of COPYLEFT_LICENSES) {
    if (normalized === l.toUpperCase()) {
      return { isCompatible: false, policyViolation: true, needsReview: false };
    }
  }

  // Check non-SPDX common copyleft name patterns
  for (const pattern of COPYLEFT_NAME_PATTERNS) {
    if (normalized.includes(pattern.toUpperCase())) {
      return { isCompatible: false, policyViolation: true, needsReview: false };
    }
  }

  // Unknown or empty
  if (normalized === 'UNKNOWN' || normalized === '') {
    return { isCompatible: true, policyViolation: false, needsReview: true };
  }

  return { isCompatible: true, policyViolation: false, needsReview: false };
}

function parsePomDependencies(pomXml: string): MavenDependency[] {
  const deps: MavenDependency[] = [];
  const depBlockRegex = /<dependency>([\s\S]*?)<\/dependency>/g;

  let match: RegExpExecArray | null;
  while ((match = depBlockRegex.exec(pomXml)) !== null) {
    const block = match[1];

    const groupIdMatch = /<groupId>\s*(.*?)\s*<\/groupId>/.exec(block);
    const artifactIdMatch = /<artifactId>\s*(.*?)\s*<\/artifactId>/.exec(block);
    const versionMatch = /<version>\s*(.*?)\s*<\/version>/.exec(block);

    if (!groupIdMatch || !artifactIdMatch || !versionMatch) continue;

    const version = versionMatch[1];

    // Skip property references like ${project.version}
    if (version.startsWith('${')) continue;

    deps.push({
      groupId: groupIdMatch[1],
      artifactId: artifactIdMatch[1],
      version,
    });
  }

  return deps;
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
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);
  const results: LicenseEntry[] = [];

  // 1. Fetch pom.xml via GitHub Contents API
  let pomContent: string;
  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'pom.xml' });
    if (!('content' in fileResp.data)) return [];
    pomContent = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
  } catch {
    return [];
  }

  // 2. Parse dependencies from pom.xml
  const deps = parsePomDependencies(pomContent);
  if (deps.length === 0) return [];

  // 3. Fetch license info from Maven Central POMs in batches
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
          const classification = classifyLicense(licenseName);

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
