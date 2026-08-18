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
    // ^18.0.0 has the lower minimum version, so it survives the worst-case merge.
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

  it('uses real semver-range comparison, not just the leading digits', () => {
    // x-range: `1.x` admits a minimum of 1.0.0, lower than the concrete 1.1.0.
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '1.1.0' } },
        { name: 'pkg', dependencies: { lodash: '1.x' } },
      ])[0].versionSpec,
    ).toBe('1.x');

    // Hyphen range: `1.2.3 - 2.3.4` admits a minimum of 1.2.3, lower than 1.5.0.
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '1.5.0' } },
        { name: 'pkg', dependencies: { lodash: '1.2.3 - 2.3.4' } },
      ])[0].versionSpec,
    ).toBe('1.2.3 - 2.3.4');

    // OR range: `^1.0.0 || ^3.0.0` admits a minimum of 1.0.0, lower than ^2.0.0.
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '^2.0.0' } },
        { name: 'pkg', dependencies: { lodash: '^1.0.0 || ^3.0.0' } },
      ])[0].versionSpec,
    ).toBe('^1.0.0 || ^3.0.0');

    // Pre-release: `^1.0.0-beta.1` sorts below the plain release `1.0.0`.
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '1.0.0' } },
        { name: 'pkg', dependencies: { lodash: '^1.0.0-beta.1' } },
      ])[0].versionSpec,
    ).toBe('^1.0.0-beta.1');
  });

  it('treats the bare wildcard forms (`x`, empty string) as non-comparable like `*`', () => {
    // These all normalize to semver's universal range and must not "win" via a
    // trivial 0.0.0 minimum — a concrete pin always surfaces over them.
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: 'x' } },
        { name: 'pkg', dependencies: { lodash: '^2.0.0' } },
      ])[0].versionSpec,
    ).toBe('^2.0.0');

    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: '' } },
        { name: 'pkg', dependencies: { lodash: '^2.0.0' } },
      ])[0].versionSpec,
    ).toBe('^2.0.0');
  });

  it('treats other non-semver spec forms (workspace:, link:) as non-comparable', () => {
    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: 'workspace:^1.0.0' } },
        { name: 'pkg', dependencies: { lodash: '1.2.3' } },
      ])[0].versionSpec,
    ).toBe('1.2.3');

    expect(
      unionNpmDeps([
        { name: 'root', dependencies: { lodash: 'link:../lodash' } },
        { name: 'pkg', dependencies: { lodash: '1.2.3' } },
      ])[0].versionSpec,
    ).toBe('1.2.3');
  });

  // --------------------------------------------------------------------------
  // `npm:` alias resolution (task 18f6c239, decided direction: resolve to the
  // real package name — see the `npm:` alias RESOLUTION paragraph in
  // unionNpmDeps' docstring). Querying OSV under the LOCAL alias key (the
  // manifest's dependency key) would report advisories for the wrong package
  // while hiding every advisory that actually affects the real package; this
  // is the direction that can never hide an advisory.
  // --------------------------------------------------------------------------
  it('npm: ALIAS: resolves an aliased dependency to the REAL package name and range, not the local alias key', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { myLodash: 'npm:lodash-es@^4.0.0' } },
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('lodash-es'); // real package, NOT the local alias key "myLodash"
    expect(deps[0].versionSpec).toBe('^4.0.0'); // the real range, now comparable
  });

  it('npm: ALIAS: resolves a SCOPED real package name correctly (scoped name\'s own leading @ is not the range separator)', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { myPkg: 'npm:@scope/pkg@^1.0.0' } },
    ]);
    expect(deps[0].name).toBe('@scope/pkg');
    expect(deps[0].versionSpec).toBe('^1.0.0');
  });

  it('npm: ALIAS: an aliased dep and a direct dep on the SAME real package merge under the real name (lowest comparable spec wins)', () => {
    // One workspace aliases an old, vulnerable lodash-es range under a local
    // binding; another workspace depends on lodash-es directly at a newer
    // range. Both must be recognized as the SAME real package so the older,
    // vulnerable floor is not hidden behind the newer direct pin.
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { compat: 'npm:lodash-es@^3.0.0' } },
      { name: 'pkg', dependencies: { 'lodash-es': '^4.0.0' } },
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('lodash-es');
    expect(deps[0].versionSpec).toBe('^3.0.0'); // the older, vulnerable floor — not hidden
  });

  it('npm: ALIAS: a malformed alias (no parseable @range suffix) falls through as a raw, non-comparable spec rather than being dropped', () => {
    // "npm:lodash-es" with no "@range" at all can't be split into a real
    // name/range pair; the caller must not guess or silently drop it — it
    // stays under the local alias key as an ordinary non-comparable spec,
    // consistent with how any other unparseable spec is handled.
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { myLodash: 'npm:lodash-es' } },
      { name: 'pkg', dependencies: { myLodash: '1.2.3' } },
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('myLodash');
    expect(deps[0].versionSpec).toBe('1.2.3'); // comparable concrete spec beats the non-comparable raw alias
  });

  // --------------------------------------------------------------------------
  // parseNpmAlias edge cases (task 18f6c239 fix-round 2, review-requested):
  // every one of these must fall through to the raw-spec/non-comparable
  // handling gracefully (never throw, never silently drop the entry), same
  // as the malformed-alias case above.
  // --------------------------------------------------------------------------
  it('npm: ALIAS EDGE CASE: bare "npm:" (nothing after the prefix) is left as a raw, non-comparable spec', () => {
    const deps = unionNpmDeps([{ name: 'root', dependencies: { myPkg: 'npm:' } }]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('myPkg');
    expect(deps[0].versionSpec).toBe('npm:');
  });

  it('npm: ALIAS EDGE CASE: "npm:@scope/pkg" with no @range suffix at all is left as a raw, non-comparable spec (the scoped name\'s own @ is not mistaken for one)', () => {
    const deps = unionNpmDeps([{ name: 'root', dependencies: { myScoped: 'npm:@scope/pkg' } }]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('myScoped');
    expect(deps[0].versionSpec).toBe('npm:@scope/pkg');
  });

  it('npm: ALIAS EDGE CASE: "npm:pkg@" (empty range after the @) is left as a raw, non-comparable spec rather than resolved with a blank range', () => {
    const deps = unionNpmDeps([{ name: 'root', dependencies: { myPkg: 'npm:pkg@' } }]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('myPkg');
    expect(deps[0].versionSpec).toBe('npm:pkg@');
  });

  it('npm: ALIAS EDGE CASE: "npm:pkg@latest" (dist-tag) resolves the REAL name, with the dist-tag itself staying non-comparable', () => {
    // A dist-tag is a parseable "@range" suffix (parseNpmAlias only checks
    // for an `@` separator, not that what follows is a semver range), so the
    // real name IS resolved — but "latest" itself has no digit and no valid
    // semver range, so it's non-comparable like any other dist-tag spec.
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { myPkg: 'npm:pkg@latest' } },
      { name: 'pkg2', dependencies: { pkg: '1.0.0' } },
    ]);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('pkg'); // resolved to the real name, not "myPkg"
    // The concrete 1.0.0 beats the non-comparable dist-tag "latest".
    expect(deps[0].versionSpec).toBe('1.0.0');
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
