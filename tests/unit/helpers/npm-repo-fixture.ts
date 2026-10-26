/**
 * Shared fixture for the end-to-end npm scan tests: a synthetic repository
 * (git tree + file contents) behind a mocked GitHub client, a mocked OSV
 * `fetch`, and builders for lockfile contents.
 *
 * A test file registers the GitHub mock itself (vi.mock is hoisted per file):
 *
 *   vi.mock('@/lib/github', async () =>
 *     (await import('./helpers/npm-repo-fixture')).githubMockModule());
 *
 * and then calls `runScan(fetchOsvAdvisories, scenario)`, which returns the
 * exact set of OSV queries (`name@version`) the real pipeline
 * (detectEcosystem -> collectDeps -> OSV querybatch) produced. Only GitHub and
 * `fetch` are mocked, so discovery, parsing, resolution and the narrow override
 * all run for real.
 */
import { vi } from 'vitest';
import { trackDegraded } from '@/lib/scan/degraded';

export interface Scenario {
  files: Record<string, string>;
  /** Paths whose content read fails with HTTP 500. */
  fail?: string[];
  /** The git tree comes back truncated (no observed lockfile set). */
  truncated?: boolean;
  /** Test-only: the manifest list is cut at its cap (more than 100 manifests). */
  extraManifests?: number;
}

const state: { files: Record<string, string>; fail: Set<string>; truncated: boolean } = {
  files: {},
  fail: new Set(),
  truncated: false,
};

function httpError(status: number, message: string): Error {
  const err: Error & { status?: number } = new Error(message);
  err.status = status;
  return err;
}

/** The module shape `vi.mock('@/lib/github', ...)` must return. */
export function githubMockModule() {
  return {
    createGitHubClient: () => ({
      rest: {
        git: {
          getTree: async () => ({
            data: {
              truncated: state.truncated,
              tree: Object.keys(state.files).map((path) => ({ path, type: 'blob' })),
            },
          }),
        },
        repos: {
          getContent: async ({ path }: { path: string }) => {
            if (state.fail.has(path)) throw httpError(500, 'boom');
            if (!(path in state.files)) throw httpError(404, 'nf');
            return { data: { content: Buffer.from(state.files[path]).toString('base64') } };
          },
          get: async () => ({ data: { default_branch: 'main' } }),
        },
      },
    }),
  };
}

/** Point the mocked GitHub client at a scenario's repository. */
export function loadRepo(scenario: Scenario): void {
  const files = { ...scenario.files };
  for (let i = 0; i < (scenario.extraManifests ?? 0); i++) {
    files[`pkg-${String(i).padStart(3, '0')}/package.json`] = JSON.stringify({ name: `filler-${i}` });
  }
  state.files = files;
  state.fail = new Set(scenario.fail ?? []);
  state.truncated = Boolean(scenario.truncated);
}

/**
 * Run the scan on a scenario and return the sorted OSV queries and the
 * degraded-source notes. Stubs global `fetch` for the duration of the call.
 */
export async function runScan(
  fetchOsvAdvisories: (token: string, owner: string, repo: string, branch: string) => Promise<unknown>,
  scenario: Scenario,
): Promise<{ queries: string[]; degraded: string | null }> {
  loadRepo(scenario);

  const bodies: Array<{ queries: Array<{ package: { name: string }; version: string }> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('querybatch')) bodies.push(JSON.parse(init!.body!));
      return { ok: true, json: async () => ({ results: [] }) };
    }),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { degraded } = await trackDegraded(() => fetchOsvAdvisories('t', 'o', 'r', 'main'));
    const queries = bodies
      .flatMap((body) => body.queries)
      .map((q) => `${q.package.name}@${q.version}`)
      .sort();
    return { queries, degraded };
  } finally {
    warn.mockRestore();
    vi.unstubAllGlobals();
  }
}

/** lockfileVersion 3 `packages` content (string values are versions). */
export const v3 = (
  entries: Record<string, string | { version?: string; name?: string; link?: boolean; resolved?: string }>,
) => {
  const packages: Record<string, unknown> = { '': {} };
  for (const [key, value] of Object.entries(entries)) {
    packages[key] = typeof value === 'string' ? { version: value } : value;
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
};

/** lockfileVersion 2: `packages` plus the legacy `dependencies` mirror. */
export const v2 = (entries: Record<string, string>, legacy: Record<string, unknown> = {}) => {
  const packages: Record<string, unknown> = { '': {} };
  for (const [key, version] of Object.entries(entries)) packages[key] = { version };
  return JSON.stringify({ lockfileVersion: 2, packages, dependencies: legacy });
};

/** lockfileVersion 1 flat `dependencies` content. */
export const v1 = (entries: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 1,
    dependencies: Object.fromEntries(
      Object.entries(entries).map(([name, version]) => [name, { version }]),
    ),
  });

/** yarn.lock v1 classic content. */
export const yarn = (entries: Array<[string, string]>) =>
  '# yarn lockfile v1\n\n' +
  entries.map(([dep, version]) => `${dep}:\n  version "${version}"\n  resolved "https://x/${version}"\n`).join('\n');

export const pkg = (o: object) => JSON.stringify(o);
