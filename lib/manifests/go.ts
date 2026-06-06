import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface GoModule {
  name: string;
  version: string;
}

const DEFAULT_PATHS = ['go.mod'];

export function parseGoMod(content: string): GoModule[] {
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
 * Extract the module path declared by a go.mod's `module` directive, or null
 * if absent. Used to recognise repo-local modules so a require on a sibling
 * module isn't treated as an external dependency.
 */
export function parseGoModuleName(content: string): string | null {
  for (const rawLine of content.split('\n')) {
    const match = rawLine.trim().match(/^module\s+(\S+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Read every discovered go.mod (root + workspace modules) and union their
 * required modules. Modules declared by one of the repo's own go.mod files are
 * dropped as workspace-internal references (the Go analogue of npm's local
 * workspace-name filter). Deduped by module path with first-seen (root-first)
 * wins.
 *
 * Note: a sibling module is only recognised as repo-local when its own go.mod
 * is among the supplied paths. If the git tree was truncated or capped
 * (MAX_MANIFESTS), a require on a then-unseen sibling falls through as an
 * external dep (a benign extra registry lookup that resolves to UNKNOWN).
 */
export async function collectGoDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<GoModule[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  // First pass: collect every locally-declared module path.
  const localModules = new Set<string>();
  for (const { content } of contents) {
    const name = parseGoModuleName(content);
    if (name) localModules.add(name);
  }

  // Second pass: union the requires, skipping repo-local modules.
  const byName = new Map<string, GoModule>();
  for (const { content } of contents) {
    for (const mod of parseGoMod(content)) {
      if (localModules.has(mod.name)) continue; // workspace-internal reference
      if (!byName.has(mod.name)) byName.set(mod.name, mod);
    }
  }

  return [...byName.values()];
}
