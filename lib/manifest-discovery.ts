import { createGitHubClient } from '@/lib/github';
import {
  type Ecosystem,
  type EcosystemInfo,
  SUPPORTED_ECOSYSTEMS,
  ecosystemPrecedence,
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
// installed packages, build output, third-party vendoring, and test scaffolding
// that ships throwaway package.json files. `examples/` is intentionally NOT
// excluded: monorepos commonly declare `examples/*` as real workspaces whose
// dependencies we want surfaced.
const EXCLUDED_DIR =
  /(^|\/)(node_modules|bower_components|\.next|\.nuxt|\.svelte-kit|dist|build|out|coverage|vendor|__fixtures__|__mocks__|fixtures|tmp)\//i;

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
  // Among ecosystems present at the shallowest depth, pick the most frequent;
  // break ties by MANIFEST_MAP precedence (npm-first) so a polyglot root with
  // both package.json and e.g. go.mod resolves to npm, matching prior behaviour.
  const counts = new Map<Ecosystem, number>();
  for (const r of refs) {
    if (depth(r.path) === minDepth) counts.set(r.ecosystem, (counts.get(r.ecosystem) ?? 0) + 1);
  }
  let best: Ecosystem = 'unknown';
  let bestCount = -1;
  let bestPrec = Number.MAX_SAFE_INTEGER;
  for (const [eco, c] of counts) {
    const prec = ecosystemPrecedence(eco);
    if (c > bestCount || (c === bestCount && prec < bestPrec)) {
      best = eco;
      bestCount = c;
      bestPrec = prec;
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
 *
 * Version collapse: if two workspaces pin the same dep at different specs, the
 * lowest (oldest) concrete spec is kept so an old, vulnerable pin in one workspace
 * is not hidden by a newer pin elsewhere (relevant for CVE / dependency-age reporting).
 * The isDev flag is decided independently: a prod occurrence anywhere clears it,
 * regardless of which spec wins. Per-workspace version reporting needs manifest
 * provenance and is a deliberate follow-up.
 */
export function unionNpmDeps(manifests: ParsedNpmManifest[]): UnionedDep[] {
  const localNames = new Set(
    manifests.map((m) => m.name).filter((n): n is string => Boolean(n)),
  );
  const byName = new Map<string, UnionedDep>();

  // Should `candidate` replace `incumbent` as the kept (lowest/oldest) spec?
  // Dependency-free (no `semver`): strip a leading range operator, then read the
  // version triple ANCHORED at the start. A spec with no numeric core (`*`,
  // `latest`, `workspace:*`, a git/url/alias spec) is "non-comparable": a concrete
  // spec always beats a non-comparable one, and two non-comparable specs keep the
  // incumbent (first-seen), so the lowest concrete pin always surfaces.
  const specIsLower = (candidate: string, incumbent: string): boolean => {
    const parse = (s: string): [number, number, number] | null => {
      const m = s.trim().replace(/^[\sv=<>~^]+/, '').match(/^\d+(?:\.\d+)?(?:\.\d+)?/);
      if (!m) return null;
      const [major = 0, minor = 0, patch = 0] = m[0].split('.').map(Number);
      return [major, minor, patch];
    };
    const pc = parse(candidate);
    if (!pc) return false; // candidate non-comparable: never displaces the incumbent
    const pi = parse(incumbent);
    if (!pi) return true; // concrete candidate beats a non-comparable incumbent
    for (let i = 0; i < 3; i++) {
      if (pc[i] !== pi[i]) return pc[i] < pi[i];
    }
    return false;
  };

  const add = (name: string, spec: string, isDev: boolean) => {
    if (localNames.has(name)) return; // workspace-internal reference
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { name, versionSpec: spec, isDev });
      return;
    }
    // Two independent dimensions: keep the lowest spec seen, and clear isDev if
    // the package is a runtime (prod) dependency in ANY manifest.
    byName.set(name, {
      name,
      versionSpec: specIsLower(spec, existing.versionSpec) ? spec : existing.versionSpec,
      isDev: existing.isDev && isDev,
    });
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
    if (data.truncated) {
      // GitHub truncates trees above ~100k entries; the manifest set may be
      // incomplete. Rare, but log so an under-count isn't silent.
      console.warn(`[manifest-discovery] truncated git tree for ${owner}/${repo}; manifest set may be partial`);
    }
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

export type Octokit = ReturnType<typeof createGitHubClient>;

export interface FetchedManifest {
  path: string;
  content: string;
}

/**
 * Fetch the raw UTF-8 contents of the given repo paths, batched to bound
 * concurrency against GitHub secondary rate limits. Unreadable / missing files
 * are skipped so one bad path can't sink the whole scan. Results preserve the
 * input order, so a downstream first-seen-wins dedup is deterministic
 * (root-first when `paths` is root-first). The shared primitive behind every
 * ecosystem's multi-manifest read.
 */
export async function fetchManifestContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
): Promise<FetchedManifest[]> {
  const results: Array<FetchedManifest | null> = new Array(paths.length).fill(null);
  const BATCH_SIZE = 10; // bound concurrency to avoid secondary rate limits
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (path, j) => {
        try {
          const resp = await octokit.rest.repos.getContent({ owner, repo, path });
          if (!('content' in resp.data)) return;
          results[i + j] = {
            path,
            content: Buffer.from(resp.data.content, 'base64').toString('utf-8'),
          };
        } catch {
          // Missing or unreadable — skip it.
        }
      }),
    );
  }
  return results.filter((r): r is FetchedManifest => r !== null);
}

/**
 * Fetch and JSON-parse the given package.json paths. Unreadable or malformed
 * manifests are skipped, so one bad file can't sink the whole scan.
 */
export async function fetchNpmManifests(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
): Promise<ParsedNpmManifest[]> {
  const out: ParsedNpmManifest[] = [];
  for (const { content } of await fetchManifestContents(octokit, owner, repo, paths)) {
    try {
      out.push(JSON.parse(content) as ParsedNpmManifest);
    } catch {
      // Malformed JSON — skip it.
    }
  }
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
