import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTree = vi.fn();
const getContent = vi.fn();
const reposGet = vi.fn();
const fakeOctokit = { rest: { git: { getTree }, repos: { get: reposGet, getContent } } };

vi.mock('@/lib/github', () => ({
  createGitHubClient: () => fakeOctokit,
}));

import {
  selectManifestPaths,
  pickPrimaryEcosystem,
  unionNpmDeps,
  detectEcosystem,
  fetchNpmManifests,
  fetchManifestContents,
  type TreeEntry,
} from '@/lib/manifest-discovery';

type Octokit = Parameters<typeof fetchNpmManifests>[0];

function contentResp(obj: unknown) {
  return { data: { content: Buffer.from(JSON.stringify(obj)).toString('base64') } };
}

function blob(path: string): TreeEntry {
  return { path, type: 'blob' };
}

describe('selectManifestPaths', () => {
  it('finds workspace + monorepo package.json files', () => {
    // agent-tasks-shaped: workspaces root + member packages.
    const refs = selectManifestPaths([
      blob('package.json'),
      blob('backend/package.json'),
      blob('frontend/package.json'),
      blob('mcp-server/package.json'),
      blob('README.md'),
    ]);
    expect(refs.map((r) => r.path)).toEqual([
      'package.json',
      'backend/package.json',
      'frontend/package.json',
      'mcp-server/package.json',
    ]);
    expect(refs.every((r) => r.ecosystem === 'npm')).toBe(true);
  });

  it('finds packages/* manifests when there is no root manifest', () => {
    // agent-dx-shaped: no root package.json, only packages/*.
    const refs = selectManifestPaths([
      blob('packages/slop-detector/package.json'),
      blob('packages/friction-log/package.json'),
      blob('LICENSE'),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.ecosystem === 'npm')).toBe(true);
  });

  it('excludes vendored / build / fixture directories', () => {
    const refs = selectManifestPaths([
      blob('package.json'),
      blob('node_modules/lodash/package.json'),
      blob('dist/package.json'),
      blob('build/foo/package.json'),
      blob('coverage/package.json'),
      blob('vendor/x/composer.json'),
      blob('tests/fixtures/sample/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual(['package.json']);
  });

  it('keeps examples/* (real workspaces commonly live there)', () => {
    const refs = selectManifestPaths([
      blob('package.json'),
      blob('examples/demo/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual(['package.json', 'examples/demo/package.json']);
  });

  it('orders shallowest paths first', () => {
    const refs = selectManifestPaths([
      blob('a/b/c/package.json'),
      blob('package.json'),
      blob('a/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual([
      'package.json',
      'a/package.json',
      'a/b/c/package.json',
    ]);
  });

  it('ignores tree entries that are not blobs', () => {
    const refs = selectManifestPaths([
      { path: 'packages', type: 'tree' },
      blob('packages/x/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual(['packages/x/package.json']);
  });
});

describe('pickPrimaryEcosystem', () => {
  it('returns unknown for an empty repo', () => {
    expect(pickPrimaryEcosystem([])).toBe('unknown');
  });

  it('picks npm for a workspaces repo', () => {
    expect(
      pickPrimaryEcosystem([
        { path: 'package.json', ecosystem: 'npm' },
        { path: 'backend/package.json', ecosystem: 'npm' },
      ]),
    ).toBe('npm');
  });

  it('picks npm for a no-root-manifest monorepo', () => {
    expect(
      pickPrimaryEcosystem([
        { path: 'packages/a/package.json', ecosystem: 'npm' },
        { path: 'packages/b/package.json', ecosystem: 'npm' },
      ]),
    ).toBe('npm');
  });

  it('prefers the ecosystem of the shallowest manifest', () => {
    // Root go.mod outranks a nested package.json.
    expect(
      pickPrimaryEcosystem([
        { path: 'go.mod', ecosystem: 'go' },
        { path: 'web/package.json', ecosystem: 'npm' },
      ]),
    ).toBe('go');
  });

  it('breaks a polyglot-root tie in npm favour (MANIFEST_MAP precedence)', () => {
    // Both at root depth: npm must win regardless of path ordering, matching
    // the pre-tree-walk behaviour. (Regression guard.)
    expect(
      pickPrimaryEcosystem([
        { path: 'go.mod', ecosystem: 'go' },
        { path: 'package.json', ecosystem: 'npm' },
      ]),
    ).toBe('npm');
    expect(
      pickPrimaryEcosystem([
        { path: 'composer.json', ecosystem: 'php' },
        { path: 'package.json', ecosystem: 'npm' },
      ]),
    ).toBe('npm');
  });
});

describe('unionNpmDeps', () => {
  it('unions prod + dev deps across manifests and dedupes by name', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^1.0.0' } },
      { name: 'pkg-a', dependencies: { react: '^18.2.0', zod: '^3.0.0' } },
    ]);
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(['react', 'vitest', 'zod']);
    // First occurrence wins for the version spec.
    expect(deps.find((d) => d.name === 'react')?.versionSpec).toBe('^18.0.0');
  });

  it('drops workspace-internal references', () => {
    const deps = unionNpmDeps([
      { name: 'pkg-a', dependencies: { 'pkg-b': '^1.0.0', lodash: '^4.0.0' } },
      { name: 'pkg-b', dependencies: {} },
    ]);
    expect(deps.map((d) => d.name)).toEqual(['lodash']);
  });

  it('promotes a dep from dev to prod when seen as a runtime dep anywhere', () => {
    const deps = unionNpmDeps([
      { name: 'a', devDependencies: { typescript: '^5.0.0' } },
      { name: 'b', dependencies: { typescript: '^5.1.0' } },
    ]);
    const ts = deps.find((d) => d.name === 'typescript');
    expect(ts?.isDev).toBe(false);
  });

  it('handles manifests with no deps (workspaces orchestration root)', () => {
    const deps = unionNpmDeps([{ name: 'agent-tasks' }]);
    expect(deps).toEqual([]);
  });

  it('keeps the lowest (most-vulnerable) spec on a cross-workspace version conflict', () => {
    // Lowest-wins so an old vulnerable pin in one workspace is not hidden by a
    // newer pin elsewhere. Both orderings must converge on the lower spec.
    const lowerSecond = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '^4.0.0' } },
      { name: 'pkg', dependencies: { lodash: '^3.0.0' } },
    ]);
    expect(lowerSecond).toHaveLength(1);
    expect(lowerSecond[0].versionSpec).toBe('^3.0.0');

    const lowerFirst = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '^3.0.0' } },
      { name: 'pkg', dependencies: { lodash: '^4.0.0' } },
    ]);
    expect(lowerFirst[0].versionSpec).toBe('^3.0.0');
  });

  it('compares versions numerically, not lexicographically', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '1.10.0' } },
      { name: 'pkg', dependencies: { lodash: '1.2.3' } },
    ]);
    expect(deps[0].versionSpec).toBe('1.2.3');
  });

  it('lets a concrete spec beat a non-comparable one regardless of order', () => {
    // A concrete pin must surface over `*` / `latest` so the real version stays visible.
    const wildcardFirst = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '*' } },
      { name: 'pkg', dependencies: { lodash: '^2.0.0' } },
    ]);
    expect(wildcardFirst[0].versionSpec).toBe('^2.0.0');

    const wildcardSecond = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '^2.0.0' } },
      { name: 'pkg', dependencies: { lodash: 'latest' } },
    ]);
    expect(wildcardSecond[0].versionSpec).toBe('^2.0.0');
  });

  it('surfaces the lowest concrete spec even when a non-comparable spec is seen first', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '*' } },
      { name: 'a', dependencies: { lodash: '2.0.0' } },
      { name: 'b', dependencies: { lodash: '1.0.0' } },
    ]);
    expect(deps[0].versionSpec).toBe('1.0.0');
  });

  it('keeps the first-seen spec when every spec is non-comparable', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { lodash: '*' } },
      { name: 'pkg', dependencies: { lodash: 'latest' } },
    ]);
    expect(deps[0].versionSpec).toBe('*');
  });

  it('treats git/url specs as non-comparable (no version pulled from the URL)', () => {
    // The 9.9.9 inside the URL must NOT be parsed; the concrete 1.2.3 wins.
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { lodash: 'git+https://github.com/foo/bar.git#v9.9.9' } },
      { name: 'pkg', dependencies: { lodash: '1.2.3' } },
    ]);
    expect(deps[0].versionSpec).toBe('1.2.3');
  });

  it('strips range operators beyond ^ when comparing', () => {
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '>=2.0.0' } },
        { name: 'pkg', dependencies: { lodash: '1.9.9' } },
      ])[0].versionSpec,
    ).toBe('1.9.9');
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '~3.0.0' } },
        { name: 'pkg', dependencies: { lodash: '2.5.0' } },
      ])[0].versionSpec,
    ).toBe('2.5.0');
  });

  it('selects the lowest spec independently of the dev/prod flag', () => {
    // dev pin lower than the prod pin: keep the lower spec AND mark it prod.
    const devLower = unionNpmDeps([
      { name: 'a', devDependencies: { lib: '^5.0.0' } },
      { name: 'b', dependencies: { lib: '^5.1.0' } },
    ]);
    expect(devLower[0].isDev).toBe(false);
    expect(devLower[0].versionSpec).toBe('^5.0.0');

    // prod pin seen first, then a lower dev pin: stays prod, keeps the lower spec.
    const prodThenLowerDev = unionNpmDeps([
      { name: 'a', dependencies: { lib: '^5.1.0' } },
      { name: 'b', devDependencies: { lib: '^5.0.0' } },
    ]);
    expect(prodThenLowerDev[0].isDev).toBe(false);
    expect(prodThenLowerDev[0].versionSpec).toBe('^5.0.0');

    // dev pin seen first, then a lower prod pin: prod clears isDev, lower spec wins.
    const devThenLowerProd = unionNpmDeps([
      { name: 'a', devDependencies: { lib: '^5.1.0' } },
      { name: 'b', dependencies: { lib: '^5.0.0' } },
    ]);
    expect(devThenLowerProd[0].isDev).toBe(false);
    expect(devThenLowerProd[0].versionSpec).toBe('^5.0.0');
  });
});

describe('fetchNpmManifests', () => {
  beforeEach(() => {
    getContent.mockReset();
  });

  it('parses valid manifests and skips missing / malformed ones', async () => {
    getContent.mockImplementation(({ path }: { path: string }) => {
      if (path === 'package.json') return Promise.resolve(contentResp({ name: 'root' }));
      if (path === 'broken/package.json') {
        return Promise.resolve({ data: { content: Buffer.from('{ not json').toString('base64') } });
      }
      return Promise.reject(new Error('404'));
    });

    const manifests = await fetchNpmManifests(
      fakeOctokit as unknown as Octokit,
      'o',
      'r',
      ['package.json', 'broken/package.json', 'gone/package.json'],
    );
    expect(manifests).toEqual([{ name: 'root' }]);
  });
});

describe('fetchManifestContents', () => {
  beforeEach(() => {
    getContent.mockReset();
  });

  it('preserves input order and skips unreadable paths', async () => {
    getContent.mockImplementation(({ path }: { path: string }) => {
      if (path === 'a.txt') return Promise.resolve({ data: { content: Buffer.from('A').toString('base64') } });
      if (path === 'b.txt') return Promise.resolve({ data: { content: Buffer.from('B').toString('base64') } });
      return Promise.reject(new Error('404'));
    });

    const out = await fetchManifestContents(
      fakeOctokit as unknown as Octokit,
      'o',
      'r',
      ['a.txt', 'gone.txt', 'b.txt'],
    );
    // Order follows the input (root-first), regardless of resolution timing, so
    // a downstream first-seen-wins dedup is deterministic.
    expect(out).toEqual([
      { path: 'a.txt', content: 'A' },
      { path: 'b.txt', content: 'B' },
    ]);
  });
});

describe('detectEcosystem', () => {
  beforeEach(() => {
    getTree.mockReset();
    getContent.mockReset();
    reposGet.mockReset();
  });

  it('finds npm manifests across the tree (no-root-manifest monorepo)', async () => {
    getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { path: 'packages/a/package.json', type: 'blob' },
          { path: 'packages/b/package.json', type: 'blob' },
          { path: 'node_modules/x/package.json', type: 'blob' },
        ],
      },
    });

    const info = await detectEcosystem('tok', 'o', 'r', 'master');
    expect(info.ecosystem).toBe('npm');
    expect(info.supported).toBe(true);
    expect(info.manifestPaths).toEqual(['packages/a/package.json', 'packages/b/package.json']);
    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: 'master', recursive: 'true' }),
    );
  });

  it('falls back to a root probe when getTree throws', async () => {
    getTree.mockRejectedValue(new Error('boom'));
    getContent.mockResolvedValue({
      data: [
        { name: 'package.json', type: 'file' },
        { name: 'README.md', type: 'file' },
      ],
    });

    const info = await detectEcosystem('tok', 'o', 'r', 'main');
    expect(info.ecosystem).toBe('npm');
    expect(info.manifestPaths).toEqual(['package.json']);
  });

  it('resolves the default branch when none is supplied', async () => {
    reposGet.mockResolvedValue({ data: { default_branch: 'trunk' } });
    getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: 'package.json', type: 'blob' }] } });

    const info = await detectEcosystem('tok', 'o', 'r');
    expect(reposGet).toHaveBeenCalled();
    expect(getTree).toHaveBeenCalledWith(expect.objectContaining({ tree_sha: 'trunk' }));
    expect(info.manifestPaths).toEqual(['package.json']);
  });

  it('returns unknown for a repo with no manifests', async () => {
    getTree.mockResolvedValue({ data: { truncated: false, tree: [{ path: 'README.md', type: 'blob' }] } });
    getContent.mockResolvedValue({ data: [{ name: 'README.md', type: 'file' }] });

    const info = await detectEcosystem('tok', 'o', 'r', 'main');
    expect(info.ecosystem).toBe('unknown');
    expect(info.supported).toBe(false);
    expect(info.manifestPaths).toEqual([]);
  });
});
