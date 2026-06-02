import { createGitHubClient } from '@/lib/github';
import {
  type Ecosystem,
  type EcosystemInfo,
  SUPPORTED_ECOSYSTEMS,
  manifestEcosystem,
} from '@/lib/ecosystem';

export interface TreeEntry {
  path?: string;
  type?: string;
}

export interface ManifestRef {
  path: string;
  ecosystem: Ecosystem;
}

// Directories whose manifests are never the project's own dependencies:
// installed packages, build output, third-party vendoring, and test/example
// scaffolding that ships throwaway package.json files.
const EXCLUDED_DIR =
  /(^|\/)(node_modules|bower_components|\.git|\.next|\.nuxt|\.svelte-kit|dist|build|out|coverage|vendor|__fixtures__|__mocks__|fixtures|examples?|tmp)\//i;

// Hard cap so a pathological repo (e.g. committed node_modules that slipped the
// regex) can't fan out into thousands of registry lookups.
const MAX_MANIFESTS = 100;

function depth(path: string): number {
  return path.split('/').length;
}

/**
 * Pure: turn a flat git tree into the list of dependency manifests it contains,
 * excluding vendored/build/fixture directories. Ordered root-first (shallowest
 * paths first) so the repo-level manifest wins ties.
 */
export function selectManifestPaths(entries: TreeEntry[]): ManifestRef[] {
  const refs: ManifestRef[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (EXCLUDED_DIR.test('/' + entry.path)) continue;
    const ecosystem = manifestEcosystem(entry.path);
    if (!ecosystem) continue;
    refs.push({ path: entry.path, ecosystem });
  }
  refs.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  return refs.slice(0, MAX_MANIFESTS);
}

/**
 * Pure: choose the repo's primary ecosystem from its manifests. Prefers the
 * ecosystem of the shallowest manifest (root wins); on a tie at the same depth,
 * the one with the most manifests. Returns 'unknown' for an empty list.
 */
export function pickPrimaryEcosystem(refs: ManifestRef[]): Ecosystem {
  if (refs.length === 0) return 'unknown';
  const minDepth = Math.min(...refs.map((r) => depth(r.path)));
  const counts = new Map<Ecosystem, number>();
  for (const r of refs) counts.set(r.ecosystem, (counts.get(r.ecosystem) ?? 0) + 1);
  // Among ecosystems present at the shallowest depth, pick the most frequent.
  const shallow = refs.filter((r) => depth(r.path) === minDepth);
  let best = shallow[0].ecosystem;
  let bestCount = -1;
  for (const r of shallow) {
    const c = counts.get(r.ecosystem) ?? 0;
    if (c > bestCount) {
      best = r.ecosystem;
      bestCount = c;
    }
  }
  return best;
}

export interface ParsedNpmManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface UnionedDep {
  name: string;
  versionSpec: string;
  isDev: boolean;
}

/**
 * Pure: union prod + dev dependencies across every workspace/package manifest,
 * dropping workspace-internal references (a dep whose name is one of the local
 * manifests' own `name`). Deduped by package name; a prod occurrence outranks a
 * dev one.
 */
export function unionNpmDeps(manifests: ParsedNpmManifest[]): UnionedDep[] {
  const localNames = new Set(
    manifests.map((m) => m.name).filter((n): n is string => Boolean(n)),
  );
  const byName = new Map<string, UnionedDep>();

  const add = (name: string, spec: string, isDev: boolean) => {
    if (localNames.has(name)) return; // workspace-internal reference
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { name, versionSpec: spec, isDev });
    } else if (existing.isDev && !isDev) {
      // Promote: the package is a real runtime dep somewhere in the workspace.
      byName.set(name, { name, versionSpec: spec, isDev: false });
    }
  };

  for (const m of manifests) {
    for (const [name, spec] of Object.entries(m.dependencies ?? {})) add(name, String(spec), false);
    for (const [name, spec] of Object.entries(m.devDependencies ?? {})) add(name, String(spec), true);
  }

  return [...byName.values()];
}

/**
 * Detect the repo's primary ecosystem and every manifest path of that ecosystem
 * by walking the full git tree once. Falls back to a root-only probe when the
 * tree can't be read or comes back truncated, so single-root repos never
 * regress.
 */
export async function detectEcosystem(
  accessToken: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<EcosystemInfo> {
  const octokit = createGitHubClient(accessToken);

  let refs: ManifestRef[] = [];
  let needFallback = false;
  try {
    const ref = branch ?? (await resolveDefaultBranch(octokit, owner, repo));
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });
    refs = selectManifestPaths((data.tree ?? []) as TreeEntry[]);
    if (data.truncated || refs.length === 0) needFallback = true;
  } catch {
    needFallback = true;
  }

  // Fallback: probe the repo root for manifests (legacy behaviour). Merge so a
  // truncated tree that already surfaced some manifests doesn't lose the root.
  if (needFallback) {
    const rootRefs = await probeRootManifests(octokit, owner, repo);
    const seen = new Set(refs.map((r) => r.path));
    for (const r of rootRefs) if (!seen.has(r.path)) refs.push(r);
    refs.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  }

  const primary = pickPrimaryEcosystem(refs);
  const manifestPaths = refs.filter((r) => r.ecosystem === primary).map((r) => r.path);

  return {
    ecosystem: primary,
    manifestFile: manifestPaths[0] ?? null,
    supported: SUPPORTED_ECOSYSTEMS.has(primary),
    manifestPaths,
  };
}

/**
 * Fetch and JSON-parse the given package.json paths. Unreadable or malformed
 * manifests are skipped, so one bad file can't sink the whole scan.
 */
export async function fetchNpmManifests(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  paths: string[],
): Promise<ParsedNpmManifest[]> {
  const out: ParsedNpmManifest[] = [];
  await Promise.all(
    paths.map(async (path) => {
      try {
        const resp = await octokit.rest.repos.getContent({ owner, repo, path });
        if (!('content' in resp.data)) return;
        const content = Buffer.from(resp.data.content, 'base64').toString('utf-8');
        out.push(JSON.parse(content) as ParsedNpmManifest);
      } catch {
        // Missing or invalid manifest — skip it.
      }
    }),
  );
  return out;
}

async function resolveDefaultBranch(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

async function probeRootManifests(
  octokit: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
): Promise<ManifestRef[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: '' });
    if (!Array.isArray(data)) return [];
    const refs: ManifestRef[] = [];
    for (const f of data) {
      if (f.type !== 'file') continue;
      const ecosystem = manifestEcosystem(f.name);
      if (ecosystem) refs.push({ path: f.name, ecosystem });
    }
    return refs;
  } catch {
    return [];
  }
}
