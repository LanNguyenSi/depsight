import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';
import { isNothingThere, noteDegraded } from '@/lib/scan/degraded';

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

// ---- Resolved versions (composer.lock) ---------------------------------------

/**
 * Reduce a composer version constraint to the one version OSV is asked about:
 * an `@<stability>` suffix is dropped (an `as <alias>` falls away with the first term), then the first
 * alternative of an `||`/`|` list, the first term of an AND list (space or
 * comma, whitespace after the operator allowed), its operator stripped, and a
 * wildcard segment (`.*`, `.x`) read as `.0` (`6.4.*` gives `6.4.0`). Returns
 * '' when no release version is left: `*`, a `dev-` branch, a `-dev` branch
 * alias (`1.0.x-dev`). The caller drops those.
 */
export function composerConstraintFloor(constraint: string): string {
  const alternative = (constraint.split(/\s*\|\|?\s*/)[0] ?? '')
    .trim()
    .replace(/@[A-Za-z]+$/, '')
    .replace(/(>=|<=|!=|==|[<>=^~])\s+/g, '$1');
  const term = alternative.split(/[\s,]+/)[0] ?? '';
  if (/^[^0-9a-z]*dev-/i.test(term) || /-dev$/i.test(term)) return '';
  const version = term.replace(/^[^0-9]*/, '').replace(/\.(\*|x)(?=\.|$)/gi, '.0');
  return /\d/.test(version) ? version : '';
}

/** `require` entries of a composer.json as raw constraints; php and ext-* are skipped. */
function parseComposerRequire(content: string): Array<[string, string]> {
  try {
    const parsed = JSON.parse(content) as { require?: unknown };
    const req = parsed.require;
    if (!req || typeof req !== 'object') return [];
    return Object.entries(req as Record<string, unknown>)
      .filter(([name]) => name !== 'php' && !name.startsWith('ext-'))
      .map(([name, constraint]) => [name, String(constraint)]);
  } catch {
    return [];
  }
}

/**
 * Read the composer.lock files in the raw media type. The default contents
 * response is empty (`encoding: "none"`) for a file over 1 MB, which a large
 * lock easily is; the raw type is served up to 100 MB. A missing file is
 * skipped; any other failure is reported as an unreadable file, like
 * `fetchManifestContents` does.
 */
async function fetchComposerLocks(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const BATCH_SIZE = 10; // bound concurrency to avoid secondary rate limits
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    await Promise.all(
      paths.slice(i, i + BATCH_SIZE).map(async (path) => {
        try {
          const resp = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            mediaType: { format: 'raw' },
          });
          const data = resp.data as unknown;
          if (typeof data === 'string') out.set(path, data);
        } catch (err) {
          if (!isNothingThere(err)) noteDegraded('GitHub file read', err);
        }
      }),
    );
  }
  return out;
}

/**
 * Parse a composer.lock into `name -> installed version` over `packages` and
 * `packages-dev`. A leading `v` is dropped; a branch version (`dev-main`,
 * `1.x-dev`) is not an installed release and is skipped. Throws when the
 * content is not a JSON object, so the caller can report the lock as unread.
 */
export function parseComposerLock(content: string): Map<string, string> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('composer.lock is not a JSON object');
  }
  const out = new Map<string, string>();
  const lock = parsed as Record<string, unknown>;
  for (const key of ['packages', 'packages-dev']) {
    const list = lock[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list as Array<{ name?: unknown; version?: unknown }>) {
      if (typeof entry?.name !== 'string' || typeof entry.version !== 'string') continue;
      const version = entry.version.replace(/^v/i, '');
      if (!/^\d/.test(version) || /(^|[-.])dev$/i.test(version)) continue;
      if (!out.has(entry.name)) out.set(entry.name, version);
    }
  }
  return out;
}

/**
 * Dependencies to ask OSV about, for the OSV channel. Per composer.json, the
 * composer.lock beside it (when present) supplies the installed versions: a
 * direct dependency takes its locked version over the constraint floor, and a
 * locked package that composer.json does not list (a transitive one, or a
 * dev one) is added. Without a lock, or when the lock is empty or cannot be
 * parsed (skipped silently, like a malformed npm lockfile), the project falls
 * back to the floors of its `require`. Entries are deduped by name and version for locked ones and
 * by name (first seen, root first) for floors. A directory holding only a
 * composer.lock is not a manifest and is not read.
 */
export async function collectPhpDepsResolved(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<ComposerDep[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const lockPathOf = (p: string) => p.replace(/composer\.json$/i, 'composer.lock');
  const [manifests, lockByPath] = await Promise.all([
    fetchManifestContents(octokit, owner, repo, paths),
    fetchComposerLocks(octokit, owner, repo, paths.map(lockPathOf)),
  ]);

  const seen = new Set<string>();
  const out: ComposerDep[] = [];
  const add = (key: string, dep: ComposerDep) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dep);
  };

  for (const { path, content } of manifests) {
    let locked: Map<string, string> | null = null;
    const lockContent = lockByPath.get(lockPathOf(path));
    if (lockContent) {
      try {
        locked = parseComposerLock(lockContent);
      } catch {
        // Malformed lock: skipped like a malformed npm lockfile, the floors
        // stand. Not a degraded source, a rescan cannot clear it.
      }
    }

    const direct = new Set<string>();
    for (const [name, constraint] of parseComposerRequire(content)) {
      direct.add(name);
      const lockedVersion = locked?.get(name);
      if (lockedVersion) {
        add(`lock:${name}@${lockedVersion}`, { name, version: lockedVersion });
        continue;
      }
      const floor = composerConstraintFloor(constraint);
      if (floor) add(`floor:${name}`, { name, version: floor });
    }
    if (locked) {
      for (const [name, version] of locked) {
        if (!direct.has(name)) add(`lock:${name}@${version}`, { name, version });
      }
    }
  }

  return out;
}
