import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface ComposerDep {
  name: string;
  version: string;
}

const DEFAULT_PATHS = ['composer.json'];

/**
 * Parse composer.json to extract production dependencies.
 * Skips `php` and `ext-*` entries (PHP extensions, not packages).
 */
export function parseComposerJson(content: string): ComposerDep[] {
  const deps: ComposerDep[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return deps;
  }

  const require = parsed.require as Record<string, string> | undefined;
  if (!require || typeof require !== 'object') return deps;

  for (const [name, version] of Object.entries(require)) {
    // Skip PHP itself and extensions
    if (name === 'php' || name.startsWith('ext-')) continue;

    // Clean version constraint: strip ^, ~, >=, etc. to get base version
    const cleanVersion = String(version).replace(/^[^0-9]*/, '').split(',')[0].trim();
    deps.push({ name, version: cleanVersion });
  }

  return deps;
}

/**
 * Read every discovered composer.json (root + monorepo packages) and union
 * their `require` dependencies. Deduped by package name with first-seen
 * (root-first) wins.
 */
export async function collectPhpDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<ComposerDep[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  const byName = new Map<string, ComposerDep>();
  for (const { content } of contents) {
    for (const dep of parseComposerJson(content)) {
      if (!byName.has(dep.name)) byName.set(dep.name, dep);
    }
  }

  return [...byName.values()];
}
