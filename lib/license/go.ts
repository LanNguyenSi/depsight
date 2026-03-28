import type { LicenseEntry } from './detector';
import { createGitHubClient } from '@/lib/github';

interface GoModule {
  name: string;
  version: string;
}

function parseGoMod(content: string): GoModule[] {
  const modules: GoModule[] = [];
  const lines = content.split('\n');

  let inRequireBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Single-line require: require github.com/pkg/errors v0.9.1
    if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
      const match = trimmed.match(/^require\s+(\S+)\s+(v\S+)/);
      if (match) {
        modules.push({ name: match[1], version: match[2] });
      }
      continue;
    }

    // Multi-line require block start
    if (trimmed.startsWith('require') && trimmed.includes('(')) {
      inRequireBlock = true;
      continue;
    }

    // Multi-line require block end
    if (inRequireBlock && trimmed === ')') {
      inRequireBlock = false;
      continue;
    }

    // Inside multi-line require block
    if (inRequireBlock) {
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('//')) continue;

      const match = trimmed.match(/^(\S+)\s+(v\S+)/);
      if (match) {
        modules.push({ name: match[1], version: match[2] });
      }
    }
  }

  return modules;
}

/**
 * Scan Go module licenses.
 *
 * Documented limitation: Go module license detection is unreliable without
 * HTML scraping of pkg.go.dev or similar services. All packages are returned
 * with license: 'UNKNOWN' and needsReview: true for manual review.
 */
export async function scanGoLicenses(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<LicenseEntry[]> {
  const octokit = createGitHubClient(accessToken);

  // Read go.mod via GitHub Contents API
  let goModContent: string;
  try {
    const fileResp = await octokit.rest.repos.getContent({ owner, repo, path: 'go.mod' });
    if (!('content' in fileResp.data)) {
      return [];
    }
    goModContent = Buffer.from(fileResp.data.content, 'base64').toString('utf-8');
  } catch {
    return [];
  }

  // Parse require blocks
  const modules = parseGoMod(goModContent);

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
