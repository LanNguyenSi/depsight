/**
 * Unit tests for `resolveNarrowNpm` (lib/manifest-discovery.ts): the narrow
 * lockfile override that adds the version each manifest's own lockfile
 * installs and removes a baseline entry only when it is provably installed
 * nowhere.
 *
 * Fixture: vite is declared by `frontend/` (^7.3.5, lockfile 7.3.7) and
 * `backend/` (^8.3.0, lockfile 8.3.5); the baseline version is the floor 7.3.5.
 * `dropSafe('vite', '7.3.5')` is true for the untouched fixture and each test
 * below breaks exactly ONE thing and expects it to turn false (the positive
 * control pins that the fixture really is droppable, so a negative test cannot
 * pass vacuously). Conditions: tree walk complete, no foreign lockfile, every manifest
 * has a lockfile of its own, every declaring manifest narrow, baseline version
 * installed nowhere.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_LOCK_INDEX_NODES,
  resolveNarrowNpm,
  selectForeignLockfilePaths,
  selectNpmrcPaths,
  selectPackageManagerConfigPaths,
  type NarrowNpmInputs,
} from '@/lib/manifest-discovery';
import { pkg, v1, v2, v3 } from './helpers/npm-repo-fixture';

type Files = Record<string, string>;

function inputs(
  manifests: Files,
  locks: Files,
  overrides: Partial<NarrowNpmInputs> = {},
): NarrowNpmInputs {
  return {
    manifestPaths: Object.keys(manifests),
    manifestFiles: Object.entries(manifests).map(([path, content]) => ({ path, content })),
    lockfileFiles: Object.entries(locks).map(([path, content]) => ({ path, content })),
    observedLockfilePaths: { npm: Object.keys(locks), yarn: [] },
    observedTreeFacts: { foreignLockfilePaths: [], manifestsCapped: false, npmrcPaths: [], packageManagerConfigPaths: [] },
    ...overrides,
  };
}

const manifests = (): Files => ({
  'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
  'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
});
const locks = (): Files => ({
  'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
  'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
});

const resolve = (m: Files = manifests(), l: Files = locks(), o: Partial<NarrowNpmInputs> = {}) =>
  resolveNarrowNpm(inputs(m, l, o));
const droppable = (m?: Files, l?: Files, o?: Partial<NarrowNpmInputs>, version = '7.3.5') =>
  resolve(m, l, o).dropSafe('vite', version);
const versions = (r: ReturnType<typeof resolveNarrowNpm>) => r.additions.map((a) => `${a.name}@${a.version}`).sort();

describe('resolveNarrowNpm: positive control and additions', () => {
  it('the untouched fixture adds both installed versions and may drop the uninstalled floor', () => {
    const r = resolve();
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(true);
  });

  it('keeps a baseline version that a declaring manifest installs (counter-check)', () => {
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.5' }) };
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(versions(r)).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });

  it('dedupes additions by (name, version)', () => {
    const m = { ...manifests(), 'ops/package.json': pkg({ devDependencies: { vite: '^8.3.0' } }) };
    const l = { ...locks(), 'ops/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }) };
    expect(versions(resolve(m, l))).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('reads devDependencies like dependencies', () => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ devDependencies: { vite: '^7.3.5' } }) };
    expect(versions(resolve(m))).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    expect(droppable(m)).toBe(true);
  });

  it('reads lockfileVersion 2 like 3', () => {
    const l = { ...locks(), 'frontend/package-lock.json': v2({ 'node_modules/vite': '7.3.7' }) };
    expect(versions(resolve(manifests(), l))).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('keeps a name another local package is called, even when that package has a lockfile', () => {
    const m = { ...manifests(), 'vite-fork/package.json': pkg({ name: 'vite' }) };
    const l = { ...locks(), 'vite-fork/package-lock.json': v3({}) };
    const r = resolve(m, l);
    expect(versions(r)).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('adds nothing for a name another local package is called (the baseline never queries it)', () => {
    const m = { ...manifests(), 'vite-fork/package.json': pkg({ name: 'vite' }) };
    const r = resolve(m);
    expect(versions(r)).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('drops nothing for a name no manifest declares', () => {
    expect(resolve().dropSafe('left-pad', '1.3.0')).toBe(false);
  });
});

describe('tree walk complete', () => {
  it('observed lockfile paths unknown (truncated tree / root-probe fallback): no narrow resolution at all', () => {
    const r = resolve(manifests(), locks(), { observedLockfilePaths: null });
    expect(r.additions).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('observed lockfile paths undefined behaves like null', () => {
    const r = resolve(manifests(), locks(), { observedLockfilePaths: undefined });
    expect(r.additions).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('tree facts missing: no narrow resolution at all', () => {
    expect(resolve(manifests(), locks(), { observedTreeFacts: null }).dropSafe('vite', '7.3.5')).toBe(false);
    expect(resolve(manifests(), locks(), { observedTreeFacts: undefined }).additions).toEqual([]);
  });

  it('manifest list capped: no narrow resolution at all', () => {
    const r = resolve(manifests(), locks(), {
      observedTreeFacts: { foreignLockfilePaths: [], manifestsCapped: true, npmrcPaths: [], packageManagerConfigPaths: [] },
    });
    expect(r.additions).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('malformed tree facts (no foreign list) fall back to the baseline instead of throwing', () => {
    const facts = { manifestsCapped: false } as unknown as NarrowNpmInputs['observedTreeFacts'];
    const r = resolve(manifests(), locks(), { observedTreeFacts: facts });
    expect(r.additions).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });
});

describe('no other package manager lockfile in the tree', () => {
  for (const path of [
    'yarn.lock',
    'tools/yarn.lock',
    'pnpm-lock.yaml',
    'tools/pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'npm-shrinkwrap.json',
    'deep/er/npm-shrinkwrap.json',
    'deno.lock',
    'tools/deno.lock',
  ]) {
    it(`${path} anywhere: no narrow resolution at all`, () => {
      const r = resolve(manifests(), locks(), {
        observedTreeFacts: { foreignLockfilePaths: [path], manifestsCapped: false, npmrcPaths: [], packageManagerConfigPaths: [] },
      });
      expect(r.additions).toEqual([]);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    });
  }

  it('an observed yarn.lock path counts even when the facts list is empty', () => {
    const r = resolve(manifests(), locks(), { observedLockfilePaths: { npm: Object.keys(locks()), yarn: ['yarn.lock'] } });
    expect(r.additions).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });
});

describe('every manifest declaring the name is narrow for it', () => {
  it('a declaring manifest that was not read', () => {
    const m = manifests();
    const files = inputs(m, locks());
    files.manifestFiles = files.manifestFiles.filter((f) => f.path !== 'frontend/package.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('an unrelated manifest that was not read (it might declare the name)', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ dependencies: { vite: '^6.0.0' } }) };
    const files = inputs(m, locks());
    files.manifestFiles = files.manifestFiles.filter((f) => f.path !== 'tools/package.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('an unrelated manifest that is not valid JSON', () => {
    const m = { ...manifests(), 'tools/package.json': '{ "dependencies": ' };
    expect(droppable(m)).toBe(false);
  });

  it('a manifest whose dependencies are not an object', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ dependencies: ['vite'] }) };
    expect(droppable(m)).toBe(false);
  });

  it('a manifest whose content is not a JSON object', () => {
    expect(droppable({ ...manifests(), 'tools/package.json': 'null' })).toBe(false);
    expect(droppable({ ...manifests(), 'tools/package.json': '[]' })).toBe(false);
  });

  for (const [label, value] of [
    ['an array', ['packages/*']],
    ['an empty array', []],
    ['false', false],
    ['null', null],
    ['an object', { packages: ['packages/*'] }],
    ['a string', 'packages/*'],
  ] as Array<[string, unknown]>) {
    it(`a workspaces key (${label}) in an ancestor package.json`, () => {
      const m = { ...manifests(), 'package.json': pkg({ name: 'root', workspaces: value }) };
      const r = resolve(m);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      expect(r.additions).toEqual([]);
    });

    it(`a workspaces key (${label}) in the declaring manifest itself`, () => {
      const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' }, workspaces: value }) };
      const r = resolve(m);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      // frontend is not narrow; the standalone backend still adds its version.
      expect(versions(r)).toEqual(['vite@8.3.5']);
    });
  }

  it('an ancestor package.json that was not read', () => {
    const m = { ...manifests(), 'package.json': pkg({ name: 'root' }) };
    const files = inputs(m, locks());
    files.manifestFiles = files.manifestFiles.filter((f) => f.path !== 'package.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('an unread ancestor blocks only the manifests below it', () => {
    const m = {
      'a/package.json': pkg({ name: 'a' }),
      'a/sub/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'b/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
    };
    const l = {
      'a/sub/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'b/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    };
    const files = inputs(m, l);
    files.manifestFiles = files.manifestFiles.filter((f) => f.path !== 'a/package.json');
    const r = resolveNarrowNpm(files);
    expect(versions(r)).toEqual(['vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('an ancestor package.json that is not valid JSON', () => {
    const m = { ...manifests(), 'package.json': '{ "workspaces": ' };
    expect(droppable(m)).toBe(false);
  });

  it('an ancestor package.json without a workspaces key does not block', () => {
    const m = { ...manifests(), 'package.json': pkg({ name: 'root', private: true }) };
    const l = { ...locks(), 'package-lock.json': v3({}) };
    expect(droppable(m, l)).toBe(true);
  });

  it('a workspaces key in a directory whose NAME merely starts like the manifest directory does not block', () => {
    const m = {
      'app/package.json': pkg({ name: 'app', workspaces: ['x'] }),
      'application/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
    };
    const l = {
      'app/package-lock.json': v3({}),
      'application/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    };
    expect(versions(resolve(m, l))).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    expect(droppable(m, l)).toBe(true);
  });

  it('a workspaces key in a SIBLING package.json does not block', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ name: 'tools', workspaces: ['x'] }) };
    const l = { ...locks(), 'tools/package-lock.json': v3({}) };
    expect(droppable(m, l)).toBe(true);
  });

  it('a declaring manifest without a lockfile of its own', () => {
    const l = locks();
    delete l['frontend/package-lock.json'];
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('only an ancestor lockfile exists (never walked up to)', () => {
    const l = locks();
    delete l['frontend/package-lock.json'];
    l['package-lock.json'] = v3({ 'frontend/node_modules/vite': '7.3.7', 'node_modules/vite': '7.3.7' });
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(versions(r)).toEqual(['vite@8.3.5']);
  });

  it('a declaring manifest whose lockfile was not read', () => {
    const files = inputs(manifests(), locks());
    files.lockfileFiles = files.lockfileFiles.filter((f) => f.path !== 'frontend/package-lock.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a declaring manifest whose lockfile is not valid JSON', () => {
    expect(droppable(manifests(), { ...locks(), 'frontend/package-lock.json': '{ not json' })).toBe(false);
  });

  it('a declaring manifest whose lockfile is lockfileVersion 1', () => {
    expect(droppable(manifests(), { ...locks(), 'frontend/package-lock.json': v1({ vite: '7.3.7' }) })).toBe(false);
  });

  it('a lockfile without a lockfileVersion', () => {
    const noVersion = JSON.stringify({ packages: { 'node_modules/vite': { version: '7.3.7' } } });
    expect(droppable(manifests(), { ...locks(), 'frontend/package-lock.json': noVersion })).toBe(false);
  });

  it('a lockfile that lists the name only nested', () => {
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vitest/node_modules/vite': '7.3.7' }) };
    expect(droppable(manifests(), l)).toBe(false);
  });

  for (const [label, entry] of [
    ['no version', {}],
    ['a version without a digit', { version: 'latest' }],
    ['an empty version', { version: '' }],
    ['a link entry', { version: '7.3.7', link: true }],
    ['a different real name (alias entry)', { version: '7.3.7', name: 'rolldown-vite' }],
    ['a non-semver version', { version: '7.3' }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`a lockfile entry with ${label}`, () => {
      const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': entry }) };
      expect(droppable(manifests(), l)).toBe(false);
    });
  }

  it('an alias declaration (npm:) is never narrow', () => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { bundler: 'npm:vite@^7.3.5' } }) };
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/bundler': { name: 'vite', version: '7.3.7' } }) };
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(versions(r)).toEqual(['vite@8.3.5']);
  });

  it('a malformed alias (no @range) is never narrow', () => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: 'npm:vite' } }) };
    expect(droppable(m)).toBe(false);
  });

  for (const spec of ['github:vitejs/vite#v7.3.5', 'latest', 'next', 'file:../vite', 'link:../vite', 'workspace:*', 'https://example.com/vite.tgz', 'git+https://example.com/vite.git']) {
    it(`a non-semver declaration (${spec}) is never narrow`, () => {
      const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: spec } }) };
      const r = resolve(m);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      expect(versions(r)).toEqual(['vite@8.3.5']);
    });
  }

  it('an installed version outside the declared range (stale lockfile)', () => {
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': '7.0.1' }) };
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(versions(r)).toEqual(['vite@8.3.5']);
  });

  it('a prerelease installed version inside a prerelease range is narrow', () => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: '^7.0.0-beta.1' } }) };
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': '7.0.0-beta.4' }) };
    expect(versions(resolve(m, l))).toEqual(['vite@7.0.0-beta.4', 'vite@8.3.5']);
  });

  it('a prerelease of a later minor inside a prerelease-bounded caret range is not narrow (npm does not accept it)', () => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: '^7.0.0-beta.1' } }) };
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': '7.1.0-beta.2' }) };
    const r = resolve(m, l);
    expect(versions(r)).toEqual(['vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a manifest that does not declare the name, with a lockfile of its own, does not block', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'tools/package-lock.json': v3({ 'node_modules/left': '1.0.0' }) };
    expect(droppable(m, l)).toBe(true);
  });
});

describe('every manifest the scan reads has a readable lockfile of its own', () => {
  it('positive control: with a lockfile for every manifest the floor may be dropped', () => {
    expect(droppable()).toBe(true);
  });

  it('a manifest that does not declare the name and has no lockfile blocks every drop', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    expect(droppable(m)).toBe(false);
  });

  it('a manifest with only `overrides` and no lockfile blocks the drop (it can install vite@7.3.5)', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ name: 'tools', overrides: { vite: '7.3.5' } }) };
    expect(droppable(m)).toBe(false);
  });

  it('a root package.json without a lockfile blocks the drop', () => {
    const m = { ...manifests(), 'package.json': pkg({ name: 'root' }) };
    expect(droppable(m)).toBe(false);
  });

  it('a manifest whose own lockfile cannot be read blocks the drop', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ name: 'tools' }) };
    const files = inputs(m, { ...locks(), 'tools/package-lock.json': v3({}) });
    files.lockfileFiles = files.lockfileFiles.filter((f) => f.path !== 'tools/package-lock.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a root lockfile without a root package.json that cannot be read blocks the drop (it could install the floor)', () => {
    const files = inputs(manifests(), { ...locks(), 'package-lock.json': v3({ 'node_modules/vite': '7.3.5' }) });
    files.lockfileFiles = files.lockfileFiles.filter((f) => f.path !== 'package-lock.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a root lockfile without a root package.json that is not valid JSON blocks the drop', () => {
    expect(droppable(manifests(), { ...locks(), 'package-lock.json': '{ not json' })).toBe(false);
  });

  it('a manifest whose own lockfile is not valid JSON blocks the drop', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ name: 'tools' }) };
    expect(droppable(m, { ...locks(), 'tools/package-lock.json': '{ not json' })).toBe(false);
  });

  it('a lockfile only in an ancestor directory is not the manifest\'s own', () => {
    const m = { ...manifests(), 'tools/sub/package.json': pkg({ name: 'sub' }) };
    expect(droppable(m, { ...locks(), 'tools/package-lock.json': v3({}) })).toBe(false);
  });

  it('does not stop the additions: the narrow versions are still added', () => {
    const m = { ...manifests(), 'tools/package.json': pkg({ name: 'tools' }) };
    const r = resolve(m);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });
});

describe('optional, peer and bundled declarations are declarations of the name', () => {
  // A third project that names vite in a field other than dependencies/devDependencies.
  const withThird = (body: object, lock?: string) => ({
    m: { ...manifests(), 'plugin/package.json': pkg({ name: 'plugin', ...body }) },
    l: lock === undefined ? locks() : { ...locks(), 'plugin/package-lock.json': lock },
  });

  for (const field of ['optionalDependencies', 'peerDependencies'] as const) {
    it(`${field} without a lockfile blocks the drop`, () => {
      const { m, l } = withThird({ [field]: { vite: '7.3.5' } });
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} with a lockfile that satisfies the range does not block, and adds nothing`, () => {
      const { m, l } = withThird({ [field]: { vite: '>=7 <9' } }, v3({ 'node_modules/vite': '7.3.7' }));
      const r = resolve(m, l);
      expect(r.dropSafe('vite', '7.3.5')).toBe(true);
      expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    });

    it(`${field} whose lockfile installs a version outside the range blocks the drop`, () => {
      const { m, l } = withThird({ [field]: { vite: '7.3.5' } }, v3({ 'node_modules/vite': '7.3.7' }));
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} that installs the baseline version blocks the drop`, () => {
      const { m, l } = withThird({ [field]: { vite: '7.3.5' } }, v3({ 'node_modules/vite': '7.3.5' }));
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} with an alias or a non-range spec blocks the drop`, () => {
      for (const spec of ['npm:vite@7.3.7', 'github:vitejs/vite#v7.3.7', 'latest']) {
        const { m, l } = withThird({ [field]: { vite: spec } }, v3({ 'node_modules/vite': '7.3.7' }));
        expect(droppable(m, l)).toBe(false);
      }
    });

    it(`${field} inside a workspaces project blocks the drop`, () => {
      const { m, l } = withThird({ [field]: { vite: '>=7' }, workspaces: ['x'] }, v3({ 'node_modules/vite': '7.3.7' }));
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} alone adds nothing, even with a matching lockfile`, () => {
      const m = { 'plugin/package.json': pkg({ name: 'plugin', [field]: { vite: '>=7' } }) };
      const l = { 'plugin/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }) };
      expect(versions(resolve(m, l))).toEqual([]);
    });

    it(`${field} that is not an object makes the manifest unread and blocks the drop`, () => {
      const { m, l } = withThird({ [field]: ['vite'] }, v3({}));
      expect(droppable(m, l)).toBe(false);
    });
  }

  for (const field of ['bundleDependencies', 'bundledDependencies'] as const) {
    it(`${field} naming the package without a lockfile blocks the drop`, () => {
      const { m, l } = withThird({ [field]: ['vite'] });
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} naming the package with a lockfile that installs another version does not block, and adds nothing`, () => {
      const { m, l } = withThird({ [field]: ['vite'] }, v3({ 'node_modules/vite': '7.3.7' }));
      const r = resolve(m, l);
      expect(r.dropSafe('vite', '7.3.5')).toBe(true);
      expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    });

    it(`${field} naming the package where the lockfile does not list it at the top level blocks the drop`, () => {
      const { m, l } = withThird({ [field]: ['vite'] }, v3({ 'node_modules/x/node_modules/vite': '7.3.7' }));
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} naming the package that installs the baseline version blocks the drop`, () => {
      const { m, l } = withThird({ [field]: ['vite'] }, v3({ 'node_modules/vite': '7.3.5' }));
      expect(droppable(m, l)).toBe(false);
    });

    it(`${field} with a non-string entry or a non-list value makes the manifest unread and blocks the drop`, () => {
      for (const value of [[1], 'vite', { vite: true }]) {
        const { m, l } = withThird({ [field]: value }, v3({}));
        expect(droppable(m, l)).toBe(false);
      }
    });

    it(`${field} naming another package does not block the drop of vite`, () => {
      const { m, l } = withThird({ [field]: ['left'] }, v3({ 'node_modules/left': '1.0.0' }));
      expect(droppable(m, l)).toBe(true);
    });
  }

  it('a boolean bundleDependencies is harmless', () => {
    const { m, l } = withThird({ bundleDependencies: true }, v3({}));
    expect(droppable(m, l)).toBe(true);
  });
});

describe('the baseline version is installed by no fetched lockfile', () => {
  it('nested transitive copy in another lockfile', () => {
    const l = {
      ...locks(),
      'backend/package-lock.json': v3({
        'node_modules/vite': '8.3.5',
        'node_modules/vitest/node_modules/vite': '7.3.5',
      }),
    };
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('top-level install in another declaring manifest lockfile', () => {
    const l = { ...locks(), 'backend/package-lock.json': v3({ 'node_modules/vite': '7.3.5' }) };
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('aliased install (name field) in another lockfile', () => {
    const l = {
      ...locks(),
      'backend/package-lock.json': v3({
        'node_modules/vite': '8.3.5',
        'node_modules/old-vite': { name: 'vite', version: '7.3.5' },
      }),
    };
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('workspace self entry named like the package in another lockfile', () => {
    const l = {
      ...locks(),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'packages/vite': { name: 'vite', version: '7.3.5' } }),
    };
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('install in a lockfile of a project that does not declare the name', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': v3({ 'node_modules/left': '1.0.0', 'node_modules/left/node_modules/vite': '7.3.5' }) };
    expect(droppable(m, l)).toBe(false);
  });

  it('install in a nested entry of the legacy dependencies mirror of a v2 lockfile', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { vitest: '^0.34.0' } }) };
    const l = {
      ...locks(),
      'legacy/package-lock.json': JSON.stringify({
        lockfileVersion: 2,
        packages: { '': {}, 'node_modules/vitest': { version: '0.34.6' } },
        dependencies: { vitest: { version: '0.34.6', dependencies: { vite: { version: '7.3.5' } } } },
      }),
    };
    expect(droppable(m, l)).toBe(false);
  });

  it('install through an alias version (npm:vite@7.3.5) in the legacy mirror of a v2 lockfile', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = {
      ...locks(),
      'legacy/package-lock.json': JSON.stringify({
        lockfileVersion: 2,
        packages: { '': {}, 'node_modules/left': { version: '1.0.0' } },
        dependencies: { left: { version: '1.0.0' }, 'old-vite': { version: 'npm:vite@7.3.5' } },
      }),
    };
    expect(droppable(m, l)).toBe(false);
  });

  it('install in the legacy dependencies mirror of a v2 lockfile', () => {
    const l = {
      ...locks(),
      'backend/package-lock.json': v2({ 'node_modules/vite': '8.3.5' }, { vite: { version: '8.3.5' }, other: { version: '1.0.0', dependencies: { vite: { version: '7.3.5' } } } }),
    };
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('an installed version that is not valid semver makes the name unknown: no version of it is droppable', () => {
    const l = { ...locks(), 'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'node_modules/x/node_modules/vite': '7.3' }) };
    expect(droppable(manifests(), l, undefined, '7.3')).toBe(false);
    expect(droppable(manifests(), l, undefined, '7.4')).toBe(false);
  });

  // The node budget is one total across all fetched lockfiles. `withNodes(total)`
  // adds projects (no dependencies) whose lockfiles hold exactly `total` nodes
  // together, in chunks far below the budget, on top of the 4 nodes of the base
  // fixture. A `packages` map counts its root entry too.
  const CHUNK = 100_000;
  const withNodes = (shape: 'packages' | 'dependencies', total: number) => {
    const m = manifests();
    const l = locks();
    let left = total;
    for (let i = 0; left > 0; i++) {
      const nodes = Math.min(CHUNK, left);
      left -= nodes;
      m[`big${i}/package.json`] = pkg({ name: `big${i}` });
      if (shape === 'packages') {
        const packages: Record<string, unknown> = { '': {} };
        for (let j = 0; j < nodes - 1; j++) packages[`node_modules/p${j}`] = { version: '1.0.0' };
        l[`big${i}/package-lock.json`] = JSON.stringify({ lockfileVersion: 3, packages });
      } else {
        // A v2 lockfile whose `packages` map holds only the root entry and whose
        // legacy mirror holds the rest.
        const dependencies: Record<string, unknown> = {};
        for (let j = 0; j < nodes - 1; j++) dependencies[`p${j}`] = { version: '1.0.0' };
        l[`big${i}/package-lock.json`] = JSON.stringify({ lockfileVersion: 2, packages: { '': {} }, dependencies });
      }
    }
    return { m, l };
  };
  const BASE_FIXTURE_NODES = 4;

  for (const shape of ['packages', 'dependencies'] as const) {
    it(`${shape}: lockfiles totalling exactly the node budget are indexed`, () => {
      const { m, l } = withNodes(shape, MAX_LOCK_INDEX_NODES - BASE_FIXTURE_NODES);
      expect(droppable(m, l)).toBe(true);
    }, 30_000);

    it(`${shape}: lockfiles totalling one node more than the budget make every name not provable`, () => {
      const { m, l } = withNodes(shape, MAX_LOCK_INDEX_NODES - BASE_FIXTURE_NODES + 1);
      const r = resolve(m, l);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      expect(r.dropSafe('vite', '1.2.3')).toBe(false);
      expect(r.dropSafe('left-pad', '1.3.0')).toBe(false);
      // The additions do not depend on the index.
      expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    }, 30_000);
  }

  it('a version that is semver-equal but spelled differently (build metadata)', () => {
    const l = { ...locks(), 'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'node_modules/x/node_modules/vite': '7.3.5+build.1' }) };
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('a baseline version spelled with build metadata matches a plain install of it', () => {
    const l = { ...locks(), 'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'node_modules/x/node_modules/vite': '7.3.5' }) };
    expect(droppable(manifests(), l, undefined, '7.3.5+sha.abc')).toBe(false);
    expect(droppable(manifests(), locks(), undefined, '7.3.5+sha.abc')).toBe(true);
  });

  it('a lockfile elsewhere that was not read', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': v3({ 'node_modules/left': '1.0.0' }) };
    const files = inputs(m, l);
    files.lockfileFiles = files.lockfileFiles.filter((f) => f.path !== 'legacy/package-lock.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a lockfile elsewhere that is not valid JSON', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': '{ not json' };
    expect(droppable(m, l)).toBe(false);
  });

  it('a lockfile elsewhere whose packages map is not an object', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: ['vite'] }) };
    expect(droppable(m, l)).toBe(false);
  });

  it('a lockfile elsewhere whose dependencies map is not an object', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: 'vite' }) };
    expect(droppable(m, l)).toBe(false);
  });

  it('the same name at a different version elsewhere does not block', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': v3({ 'node_modules/left': '1.0.0', 'node_modules/left/node_modules/vite': '6.0.0' }) };
    expect(droppable(m, l)).toBe(true);
  });

  it('a different package at the baseline version elsewhere does not block', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^7.3.5' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': v3({ 'node_modules/left': '7.3.5' }) };
    expect(droppable(m, l)).toBe(true);
  });
});

// An extra project `legacy/` next to the two vite projects. Its manifest asks for
// `left`; its lockfile is the thing under test. The vite fixture itself stays
// droppable (positive control), so each failing case below is caused by the
// legacy lockfile or manifest alone.
const withLegacy = (lock: string | object, manifestBody: object = { dependencies: { left: '^1.0.0' } }) => ({
  m: { ...manifests(), 'legacy/package.json': pkg({ name: 'legacy', ...manifestBody }) } as Files,
  l: { ...locks(), 'legacy/package-lock.json': typeof lock === 'string' ? lock : JSON.stringify(lock) } as Files,
});
const legacyDroppable = (lock: string | object, manifestBody?: object, name = 'vite', version = '7.3.5') => {
  const { m, l } = withLegacy(lock, manifestBody);
  return resolve(m, l).dropSafe(name, version);
};
const leftLock = { 'node_modules/left': '1.0.0' };

describe('every fetched lockfile has a known shape', () => {
  it('positive control: a v3 lockfile that lists its dependency is fine', () => {
    expect(legacyDroppable(v3(leftLock))).toBe(true);
  });

  it('lockfileVersion 2 with a packages object is known', () => {
    expect(legacyDroppable(v2(leftLock))).toBe(true);
  });

  it('lockfileVersion 1 is not provable, even with a dependencies object that lists everything', () => {
    // npm does not install from a v1 lockfile but re-resolves from the registry.
    expect(legacyDroppable(v1({ left: '1.0.0' }))).toBe(false);
    expect(legacyDroppable({ lockfileVersion: 1, dependencies: { left: { version: '1.0.0', requires: {} } } })).toBe(false);
  });

  it('a lockfileVersion 1 lockfile anywhere in the tree makes every name not provable', () => {
    // Elsewhere: a project that does not declare vite, and the own lockfile of a vite project.
    const m = { ...manifests(), 'legacy/package.json': pkg({ name: 'legacy', dependencies: { left: '^1.0.0' } }) };
    const l = { ...locks(), 'legacy/package-lock.json': v1({ left: '1.0.0' }) };
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(r.dropSafe('left', '0.9.0')).toBe(false);
    const own = resolve(manifests(), { ...locks(), 'frontend/package-lock.json': v1({ vite: '7.3.7' }) });
    expect(own.dropSafe('vite', '7.3.5')).toBe(false);
    // Additions are not gated by the index: the v3 lockfile still adds.
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  for (const [label, version] of [
    ['4', 4],
    ['0', 0],
    ['the string "3"', '3'],
    ['null', null],
    ['absent', undefined],
  ] as const) {
    it(`lockfileVersion ${label}: nothing is provable`, () => {
      const lock = { lockfileVersion: version, packages: { '': {}, 'node_modules/left': { version: '1.0.0' } } };
      expect(legacyDroppable(lock)).toBe(false);
    });
  }

  it('lockfileVersion 3 without a packages object', () => {
    expect(legacyDroppable({ lockfileVersion: 3 })).toBe(false);
  });

  it('lockfileVersion 2 with only the legacy dependencies mirror', () => {
    expect(legacyDroppable({ lockfileVersion: 2, dependencies: { left: { version: '1.0.0' } } })).toBe(false);
  });

  it('lockfileVersion 1 without a dependencies object', () => {
    expect(legacyDroppable({ lockfileVersion: 1 })).toBe(false);
  });

  it('a packages value that is not an object', () => {
    expect(legacyDroppable({ lockfileVersion: 3, packages: [] })).toBe(false);
    const listed = { left: { version: '1.0.0' } };
    expect(legacyDroppable({ lockfileVersion: 1, dependencies: listed })).toBe(false);
    expect(legacyDroppable({ lockfileVersion: 1, dependencies: listed, packages: [] })).toBe(false);
    expect(legacyDroppable({ lockfileVersion: 1, dependencies: listed, packages: 'x' })).toBe(false);
  });

  it('a dependencies value that is not an object, next to a good packages map', () => {
    expect(legacyDroppable({ lockfileVersion: 2, packages: { '': {}, 'node_modules/left': { version: '1.0.0' } }, dependencies: 'x' })).toBe(false);
  });

  it('a lockfile whose JSON is not an object', () => {
    expect(legacyDroppable('[]')).toBe(false);
  });
});

describe('every lockfile entry that names a package carries a semver version', () => {
  // The vite install sits nested under `left` in the legacy lockfile.
  const nestedVite = (entry: unknown) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, ...leftLockEntries, 'node_modules/left/node_modules/vite': entry },
    });
  const leftLockEntries = { 'node_modules/left': { version: '1.0.0' } };

  it('positive control: a nested vite at another semver version does not block', () => {
    expect(legacyDroppable(nestedVite({ version: '6.0.0' }))).toBe(true);
  });

  it('a nested vite at the baseline version blocks (control for the cases below)', () => {
    expect(legacyDroppable(nestedVite({ version: '7.3.5' }))).toBe(false);
  });

  for (const [label, entry] of [
    ['a git url version', { version: 'git+https://github.com/vitejs/vite.git#abc' }],
    ['a github shorthand version', { version: 'github:vitejs/vite#abc' }],
    ['a tarball url version', { version: 'https://example.com/vite.tgz' }],
    ['a file: version', { version: 'file:../vite' }],
    ['an empty version', { version: '' }],
    ['a numeric version', { version: 7 }],
    ['a null version', { version: null }],
    ['no version (only a resolved url)', { resolved: 'git+ssh://git@github.com/vitejs/vite.git#abc' }],
    ['no version at all', {}],
    ['an entry that is a string', '7.3.5'],
    ['an entry that is null', null],
    ['an entry that is a number', 7],
    ['an entry that is an array', ['7.3.5']],
  ] as const) {
    it(`a nested vite with ${label}: vite is never provably uninstalled`, () => {
      expect(legacyDroppable(nestedVite(entry))).toBe(false);
      expect(legacyDroppable(nestedVite(entry), undefined, 'vite', '1.2.3')).toBe(false);
    });
  }

  it('an unreadable entry makes only its own name unknown', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/left': { version: '1.2.0' },
        'node_modules/z': { version: '1.0.0' },
        'node_modules/z/node_modules/left': { resolved: 'git+ssh://git@github.com/o/left.git#abc' },
      },
    });
    const body = { dependencies: { left: '^1.0.0', z: '^1.0.0' } };
    expect(legacyDroppable(lock, body, 'vite', '7.3.5')).toBe(true);
    expect(legacyDroppable(lock, body, 'z', '0.9.0')).toBe(true);
    // `left` has an install whose version cannot be read: no version of it is provably uninstalled.
    expect(legacyDroppable(lock, body, 'left', '1.0.0')).toBe(false);
    // Control: without the unreadable entry the floor of `left` is installed nowhere.
    const clean = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/left': { version: '1.2.0' }, 'node_modules/z': { version: '1.0.0' } } });
    expect(legacyDroppable(clean, body, 'left', '1.0.0')).toBe(true);
  });

  it('an alias entry (name field) without a version makes the real name unknown', () => {
    expect(legacyDroppable(nestedVite({ name: 'vite' }))).toBe(false);
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...leftLockEntries, 'node_modules/old-vite': { name: 'vite' } } });
    expect(legacyDroppable(lock)).toBe(false);
  });

  it('an alias entry with a git version makes the real name unknown, not the alias key', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, ...leftLockEntries, 'node_modules/old-vite': { name: 'vite', version: 'github:x/y' } },
    });
    expect(legacyDroppable(lock)).toBe(false);
  });

  it('a name field that is not a non-empty string makes the lockfile unattributable', () => {
    for (const name of [7, '', null, ['vite']]) {
      expect(legacyDroppable(nestedVite({ name, version: '6.0.0' }))).toBe(false);
    }
  });

  it('a key that ends in node_modules/ names nothing and makes the lockfile unattributable', () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...leftLockEntries, 'node_modules/left/node_modules/': { version: '1.0.0' } } });
    expect(legacyDroppable(lock)).toBe(false);
  });

  it('exempt: the root entry, link entries and version-less workspace folder entries', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'legacy', dependencies: { left: '^1.0.0' } },
        ...leftLockEntries,
        'node_modules/linked': { resolved: 'packages/linked', link: true },
        'packages/linked': { name: 'linked' },
        'packages/other': { dependencies: { left: '^1.0.0' } },
      },
    });
    expect(legacyDroppable(lock)).toBe(true);
  });

  // `left` is declared in range by legacy (narrow, floor 1.0.0 installed nowhere);
  // the entries below sit in the lockfile of a project that does not declare it.
  const leftNarrow = (otherLock: object) => {
    const m = {
      ...manifests(),
      'legacy/package.json': pkg({ name: 'legacy', dependencies: { left: '^1.0.0' } }),
      'other/package.json': pkg({ name: 'other', dependencies: { z: '^1.0.0' } }),
    };
    const l = {
      ...locks(),
      'legacy/package-lock.json': v3({ 'node_modules/left': '1.2.0' }),
      'other/package-lock.json': JSON.stringify(otherLock),
    };
    return resolve(m, l).dropSafe('left', '1.0.0');
  };
  const zEntries = { 'node_modules/z': { version: '1.0.0' } };

  it('control for the exemptions below: another lockfile without anything about left', () => {
    expect(leftNarrow({ lockfileVersion: 3, packages: { '': {}, ...zEntries } })).toBe(true);
  });

  it('the root entry is exempt, even with an unreadable version under a dependency\'s name', () => {
    expect(leftNarrow({ lockfileVersion: 3, packages: { '': { name: 'left', version: 'not-a-version' }, ...zEntries } })).toBe(true);
  });

  it('a link entry is exempt (its target folder entry is accounted for on its own)', () => {
    const packages = { '': {}, ...zEntries, 'node_modules/left': { resolved: '../left', link: true } };
    expect(leftNarrow({ lockfileVersion: 3, packages })).toBe(true);
    // Without the link marker the same entry has no version: left is unknown.
    expect(leftNarrow({ lockfileVersion: 3, packages: { ...packages, 'node_modules/left': { resolved: '../left' } } })).toBe(false);
  });

  it('a workspace folder entry without a version is exempt, even named like a dependency', () => {
    const packages = { '': {}, ...zEntries, 'packages/left': { name: 'left' } };
    expect(leftNarrow({ lockfileVersion: 3, packages })).toBe(true);
    expect(leftNarrow({ lockfileVersion: 3, packages: { ...packages, 'packages/left': { name: 'left', version: 'x' } } })).toBe(false);
  });

  it('a workspace folder entry with a version names the package by its folder', () => {
    const named = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...leftLockEntries, 'packages/vite': { version: '7.3.5' } } });
    expect(legacyDroppable(named)).toBe(false);
    const other = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...leftLockEntries, 'packages/vite': { version: '6.0.0' } } });
    expect(legacyDroppable(other)).toBe(true);
    const unreadable = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...leftLockEntries, 'packages/vite': { version: 'git+x' } } });
    expect(legacyDroppable(unreadable)).toBe(false);
  });

  it('a non-object entry under a key that names no package makes the lockfile unattributable', () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...leftLockEntries, 'packages/odd': '1.0.0' } });
    expect(legacyDroppable(lock)).toBe(false);
  });

  it('a version with a leading v or build metadata is semver and counts as its normalised form', () => {
    expect(legacyDroppable(nestedVite({ version: 'v7.3.5' }))).toBe(false);
    expect(legacyDroppable(nestedVite({ version: 'v6.0.0' }))).toBe(true);
  });

  describe('entries of the legacy dependencies mirror of a v2 lockfile', () => {
    // `packages` lists left (the one dependency); the mirror under test hangs vite under it.
    const mirror = (dependencies: unknown) =>
      JSON.stringify({ lockfileVersion: 2, packages: { '': {}, ...leftLockEntries }, dependencies });
    const v1Nested = (entry: unknown) =>
      mirror({ left: { version: '1.0.0', dependencies: { vite: entry } } });

    it('positive control and counter-control', () => {
      expect(legacyDroppable(v1Nested({ version: '6.0.0' }))).toBe(true);
      expect(legacyDroppable(v1Nested({ version: '7.3.5' }))).toBe(false);
    });

    for (const [label, entry] of [
      ['a git version', { version: 'github:vitejs/vite#abc', from: 'github:vitejs/vite' }],
      ['a tarball version', { version: 'https://example.com/vite.tgz' }],
      ['a file: version', { version: 'file:../vite' }],
      ['no version', { from: 'vite@^7' }],
      ['an entry that is a string', '7.3.5'],
      ['an entry that is null', null],
    ] as const) {
      it(`a nested vite with ${label}: vite is never provably uninstalled`, () => {
        expect(legacyDroppable(v1Nested(entry))).toBe(false);
        expect(legacyDroppable(v1Nested(entry), undefined, 'vite', '1.2.3')).toBe(false);
      });
    }

    it('an alias version with a semver range installs the real name at that version', () => {
      const alias = (version: string) =>
        mirror({ left: { version: '1.0.0' }, 'old-vite': { version: `npm:vite@${version}` } });
      expect(legacyDroppable(alias('6.0.0'))).toBe(true);
      expect(legacyDroppable(alias('7.3.5'))).toBe(false);
    });

    it('an alias version whose range is not semver makes the real name unknown', () => {
      const lock = mirror({ left: { version: '1.0.0' }, 'old-vite': { version: 'npm:vite@github:x/y' } });
      expect(legacyDroppable(lock)).toBe(false);
    });

    it('an npm: version that does not parse makes the lockfile unattributable', () => {
      const lock = mirror({ left: { version: '1.0.0' }, 'old-vite': { version: 'npm:vite' } });
      expect(legacyDroppable(lock)).toBe(false);
    });

    it('nested dependencies of an entry with an unreadable version are still walked', () => {
      const lock = mirror({ left: { version: 'github:o/left#abc', dependencies: { vite: { version: '7.3.5' } } } });
      expect(legacyDroppable(lock)).toBe(false);
    });

    it('a nested dependencies value that is not an object makes the lockfile unattributable', () => {
      const lock = mirror({ left: { version: '1.0.0', dependencies: [] } });
      expect(legacyDroppable(lock)).toBe(false);
    });
  });
});

describe('every manifest the scan reads is locked: its own lockfile lists every declared dependency', () => {
  const lockOf = (entries: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...entries } });

  it('positive control: dependencies, devDependencies and optionalDependencies all listed in range', () => {
    const body = { dependencies: { a: '^1.0.0' }, devDependencies: { b: '~2.1.0' }, optionalDependencies: { c: '3.0.0' } };
    const lock = lockOf({ 'node_modules/a': { version: '1.4.0' }, 'node_modules/b': { version: '2.1.9' }, 'node_modules/c': { version: '3.0.0' } });
    expect(legacyDroppable(lock, body)).toBe(true);
  });

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    it(`a ${field} key the lockfile does not list: the manifest is not locked`, () => {
      expect(legacyDroppable(lockOf({}), { [field]: { a: '^1.0.0' } })).toBe(false);
    });

    it(`a ${field} key the lockfile lists only nested: the manifest is not locked`, () => {
      expect(legacyDroppable(lockOf({ 'node_modules/z/node_modules/a': { version: '1.0.0' } }), { [field]: { a: '^1.0.0' } })).toBe(false);
    });

    it(`a ${field} key whose listed version is outside the declared range: the manifest is not locked`, () => {
      expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.0.0' } }), { [field]: { a: '^2.0.0' } })).toBe(false);
    });

    it(`one missing ${field} key among several listed ones`, () => {
      const body = { [field]: { a: '^1.0.0', b: '^1.0.0' } };
      expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.0.0' } }), body)).toBe(false);
      expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.0.0' } }), body)).toBe(true);
    });
  }

  it('a peerDependencies key the lockfile does not list: the manifest is not locked (npm installs peers)', () => {
    expect(legacyDroppable(lockOf({}), { peerDependencies: { a: '^1.0.0' } })).toBe(false);
  });

  it('bundled names need not be listed either', () => {
    expect(legacyDroppable(lockOf({}), { bundleDependencies: ['a'] })).toBe(true);
  });

  it('a prerelease satisfies only a range that names a prerelease of the same release (as npm judges a lockfile)', () => {
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.0.0-beta.2' } }), { dependencies: { a: '^1.0.0-beta.1' } })).toBe(true);
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.2.0-beta.1' } }), { dependencies: { a: '^1.0.0-beta.1' } })).toBe(false);
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.2.0-beta.1' } }), { dependencies: { a: '^1.0.0' } })).toBe(false);
  });

  it('the wildcard and empty specs accept any listed version', () => {
    const lock = lockOf({ 'node_modules/a': { version: '9.9.9' }, 'node_modules/b': { version: '0.0.1' } });
    expect(legacyDroppable(lock, { dependencies: { a: '*', b: '' } })).toBe(true);
  });

  describe('a spec that is not a plain semver range only needs the entry to exist', () => {
    for (const spec of ['github:o/a#v1', 'git+https://example.com/a.git', 'file:../a', 'latest', 'next', 'npm:other@^1.0.0', 'workspace:*', 'https://example.com/a.tgz']) {
      it(`${spec}: listed → locked, missing → not locked`, () => {
        const body = { dependencies: { a: spec } };
        expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.0.0', resolved: spec } }), body)).toBe(true);
        expect(legacyDroppable(lockOf({}), body)).toBe(false);
      });
    }

    it('an entry that is not an object does not count as listed', () => {
      expect(legacyDroppable(lockOf({ 'node_modules/a': '1.0.0' }), { dependencies: { a: 'latest' } })).toBe(false);
    });
  });

  it('a link entry satisfies a non-semver spec but never a plain range, even with a version', () => {
    const lock = lockOf({ 'node_modules/a': { resolved: 'packages/a', link: true }, 'packages/a': { name: 'a', version: '1.0.0' } });
    expect(legacyDroppable(lock, { dependencies: { a: 'file:../a' } })).toBe(true);
    expect(legacyDroppable(lock, { dependencies: { a: '^1.0.0' } })).toBe(false);
    const versioned = lockOf({ 'node_modules/a': { resolved: 'packages/a', link: true, version: '1.0.0' }, 'packages/a': { name: 'a', version: '1.0.0' } });
    expect(legacyDroppable(versioned, { dependencies: { a: '^1.0.0' } })).toBe(false);
  });

  it('an entry installed under another name (alias) does not satisfy a plain range', () => {
    const lock = lockOf({ 'node_modules/a': { name: 'other', version: '1.0.0' } });
    expect(legacyDroppable(lock, { dependencies: { a: '^1.0.0' } })).toBe(false);
    expect(legacyDroppable(lock, { dependencies: { a: 'npm:other@^1.0.0' } })).toBe(true);
  });

  it('a listed entry without a readable version does not satisfy a plain range', () => {
    expect(legacyDroppable(lockOf({ 'node_modules/a': { resolved: 'x' } }), { dependencies: { a: '^1.0.0' } })).toBe(false);
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: 'github:o/a' } }), { dependencies: { a: '^1.0.0' } })).toBe(false);
  });

  it('a local package name is not exempt: a stale lockfile that lacks it still installs it fresh', () => {
    const { m, l } = withLegacy(lockOf({}), { dependencies: { sibling: '^1.0.0' } });
    const withSibling = { ...m, 'sibling/package.json': pkg({ name: 'sibling' }) };
    expect(resolve(withSibling, { ...l, 'sibling/package-lock.json': v3({}) }).dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a lockfileVersion 1 own lockfile never locks the manifest, whatever it lists', () => {
    const v1Lock = (deps: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 1, dependencies: deps });
    expect(legacyDroppable(v1Lock({ a: { version: '1.2.0' } }), { dependencies: { a: '^1.0.0' } })).toBe(false);
    expect(legacyDroppable(v1Lock({ a: { version: 'github:o/a#abc' } }), { dependencies: { a: 'github:o/a#v1' } })).toBe(false);
  });

  it('a key called __proto__ is listed only by an entry of its own', () => {
    const body = '{"name":"legacy","dependencies":{"__proto__":"latest"}}';
    const { m, l } = withLegacy(lockOf({}));
    expect(resolve({ ...m, 'legacy/package.json': body }, l).dropSafe('vite', '7.3.5')).toBe(false);
    const listed = withLegacy(lockOf({ 'node_modules/__proto__': { version: '1.0.0' } }));
    expect(resolve({ ...listed.m, 'legacy/package.json': body }, listed.l).dropSafe('vite', '7.3.5')).toBe(true);
  });

  it('a manifest with a dependency spec that is not a string counts as unread', () => {
    const { m, l } = withLegacy(lockOf({ 'node_modules/a': { version: '1.0.0' } }));
    const broken = { ...m, 'legacy/package.json': '{"name":"legacy","dependencies":{"a":1}}' };
    const r = resolve(broken, l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    // Only that manifest is unread: the others still add their versions.
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('does not stop the additions: the narrow versions are still added', () => {
    const { m, l } = withLegacy(lockOf({}), { dependencies: { a: '^1.0.0' } });
    const r = resolve(m, l);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });
});

describe('peerDependencies are listed in range like dependencies, optional peers excepted', () => {
  const lockOf = (entries: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...entries } });
  const peerA = { peerDependencies: { a: '^1.0.0' } };

  it('positive control: the peer is listed in range', () => {
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.4.0', peer: true } }), peerA)).toBe(true);
  });

  it('a peer the lockfile does not list at all', () => {
    expect(legacyDroppable(lockOf({}), peerA)).toBe(false);
  });

  it('a peer the lockfile lists only nested', () => {
    expect(legacyDroppable(lockOf({ 'node_modules/z/node_modules/a': { version: '1.4.0' } }), peerA)).toBe(false);
  });

  it('a peer listed outside its range', () => {
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '2.0.0', peer: true } }), peerA)).toBe(false);
  });

  it('a peer next to a listed dependency: both must be listed', () => {
    const body = { dependencies: { ms: '^2.0.0' }, peerDependencies: { a: '^1.0.0' } };
    expect(legacyDroppable(lockOf({ 'node_modules/ms': { version: '2.1.3' } }), body)).toBe(false);
    expect(legacyDroppable(lockOf({ 'node_modules/ms': { version: '2.1.3' }, 'node_modules/a': { version: '1.4.0' } }), body)).toBe(true);
  });

  it('a peer marked optional in peerDependenciesMeta need not be listed (positive control)', () => {
    const body = { ...peerA, peerDependenciesMeta: { a: { optional: true } } };
    expect(legacyDroppable(lockOf({}), body)).toBe(true);
  });

  it('only optional: true exempts a peer', () => {
    for (const meta of [{ a: { optional: false } }, { a: { optional: 'true' } }, { a: {} }, { a: true }, { a: null }, { other: { optional: true } }]) {
      expect(legacyDroppable(lockOf({}), { ...peerA, peerDependenciesMeta: meta })).toBe(false);
    }
  });

  it('an optional peer exempts only itself', () => {
    const body = { peerDependencies: { a: '^1.0.0', b: '^1.0.0' }, peerDependenciesMeta: { a: { optional: true } } };
    expect(legacyDroppable(lockOf({}), body)).toBe(false);
    expect(legacyDroppable(lockOf({ 'node_modules/b': { version: '1.0.0' } }), body)).toBe(true);
  });

  it('peerDependenciesMeta exempts a peer only, not a dependency of the same name', () => {
    const body = { dependencies: { a: '^1.0.0' }, peerDependenciesMeta: { a: { optional: true } } };
    expect(legacyDroppable(lockOf({}), body)).toBe(false);
  });

  it('peerDependenciesMeta that is not an object makes the manifest unread and blocks the drop', () => {
    for (const meta of [['a'], 'a', null, 1]) {
      expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.0.0' } }), { ...peerA, peerDependenciesMeta: meta })).toBe(false);
    }
  });

  it('the additions stay when a peer blocks the drop', () => {
    const { m, l } = withLegacy(lockOf({}), peerA);
    expect(versions(resolve(m, l))).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('overrides: a plain string override must be reflected in the own lockfile', () => {
  const lockOf = (entries: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...entries } });
  const leftEntry = { 'node_modules/left': { version: '1.0.0' } };
  const withOverrides = (overrides: unknown) => ({ dependencies: { left: '^1.0.0' }, overrides });
  const ok = (entries: Record<string, unknown>, overrides: unknown) =>
    legacyDroppable(lockOf({ ...leftEntry, ...entries }), withOverrides(overrides));

  it('positive control: every entry of the overridden name satisfies the override', () => {
    expect(ok({ 'node_modules/ms': { version: '2.1.3' }, 'node_modules/left/node_modules/ms': { version: '2.1.3' } }, { ms: '2.1.3' })).toBe(true);
  });

  it('no overrides, an empty overrides object, and an override of a name the lockfile lacks', () => {
    expect(legacyDroppable(lockOf(leftEntry), { dependencies: { left: '^1.0.0' } })).toBe(true);
    expect(ok({}, {})).toBe(true);
    expect(ok({}, { ms: '2.1.3' })).toBe(true);
  });

  it('a range override is satisfied by a version inside it', () => {
    expect(ok({ 'node_modules/ms': { version: '2.1.3' } }, { ms: '^2.1.0' })).toBe(true);
    expect(ok({ 'node_modules/ms': { version: '2.0.0' } }, { ms: '^2.1.0' })).toBe(false);
  });

  it('a top-level entry outside the override (stale lockfile)', () => {
    expect(ok({ 'node_modules/ms': { version: '2.1.2' } }, { ms: '2.1.3' })).toBe(false);
  });

  it('a nested entry outside the override', () => {
    expect(ok({ 'node_modules/ms': { version: '2.1.3' }, 'node_modules/left/node_modules/ms': { version: '2.0.0' } }, { ms: '2.1.3' })).toBe(false);
  });

  it('an entry installed under an alias key (name field) outside the override', () => {
    expect(ok({ 'node_modules/old-ms': { name: 'ms', version: '2.0.0' } }, { ms: '2.1.3' })).toBe(false);
    expect(ok({ 'node_modules/old-ms': { name: 'ms', version: '2.1.3' } }, { ms: '2.1.3' })).toBe(true);
  });

  it('a workspace folder entry that names the overridden package', () => {
    expect(ok({ 'packages/ms': { name: 'ms', version: '2.0.0' } }, { ms: '2.1.3' })).toBe(false);
  });

  it('an entry named after another package is not an entry of the overridden name', () => {
    expect(ok({ 'node_modules/ms': { name: 'other', version: '2.0.0' } }, { ms: '2.1.3' })).toBe(true);
  });

  it('a name field that is not a string could rename the entry: not locked', () => {
    expect(ok({ 'node_modules/ms': { name: 5, version: '2.1.3' } }, { ms: '2.1.3' })).toBe(false);
    expect(ok({ 'node_modules/ms': { name: '', version: '2.1.3' } }, { ms: '2.1.3' })).toBe(false);
  });

  it('an entry of the overridden name without a readable version', () => {
    for (const entry of [{ resolved: 'git+ssh://x' }, {}, { version: 2 }, { version: null }, { version: 'github:o/ms#abc' }, { version: '2.1.3-beta.1' }]) {
      expect(ok({ 'node_modules/ms': entry }, { ms: '2.1.3' })).toBe(false);
    }
  });

  it('an entry of the overridden name that is not an object', () => {
    expect(ok({ 'node_modules/ms': '2.1.3' }, { ms: '2.1.3' })).toBe(false);
    expect(ok({ 'node_modules/ms': null }, { ms: '2.1.3' })).toBe(false);
  });

  it('a link entry installs no registry version and is skipped', () => {
    expect(ok({ 'node_modules/ms': { link: true, resolved: 'vendor/ms' } }, { ms: '2.1.3' })).toBe(true);
  });

  it('the root entry names the project, not an install of the overridden name', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'ms', version: '9.9.9' }, ...leftEntry },
    });
    expect(legacyDroppable(lock, withOverrides({ ms: '2.1.3' }))).toBe(true);
  });

  it('an entry of another name is not checked, and a non-object entry of another name does not matter', () => {
    expect(ok({ 'node_modules/other': { version: '9.9.9' }, 'node_modules/odd': 'x' }, { ms: '2.1.3' })).toBe(true);
  });

  it('a workspace folder entry without a name installs nothing under an overridden name', () => {
    expect(ok({ 'packages/anon': { version: '2.0.0' } }, { ms: '2.1.3' })).toBe(true);
  });

  it('every override is checked, not only the first', () => {
    const entries = { 'node_modules/ms': { version: '2.1.3' }, 'node_modules/qs': { version: '6.0.0' } };
    expect(ok(entries, { ms: '2.1.3', qs: '6.0.0' })).toBe(true);
    expect(ok(entries, { ms: '2.1.3', qs: '6.1.0' })).toBe(false);
    expect(ok(entries, { qs: '6.1.0', ms: '2.1.3' })).toBe(false);
  });

  it('a scoped name is an overridable name', () => {
    expect(ok({ 'node_modules/@s/ms': { version: '2.1.3' } }, { '@s/ms': '2.1.3' })).toBe(true);
    expect(ok({ 'node_modules/@s/ms': { version: '2.0.0' } }, { '@s/ms': '2.1.3' })).toBe(false);
  });

  describe('an override that is not a plain string spec: the manifest is not locked', () => {
    const entries = { 'node_modules/ms': { version: '2.1.3' } };
    for (const [label, overrides] of [
      ['a nested object', { ms: { '.': '2.1.3' } }],
      ['a nested object under another package', { left: { ms: '2.1.3' } }],
      ['a number', { ms: 2 }],
      ['a boolean', { ms: true }],
      ['null', { ms: null }],
      ['an array', { ms: ['2.1.3'] }],
      ['a $ reference', { ms: '$ms' }],
      ['an empty spec', { ms: '' }],
      ['a blank spec', { ms: '  ' }],
      ['an alias spec', { ms: 'npm:other@2.1.3' }],
      ['a git spec', { ms: 'github:o/ms#v2' }],
      ['a tag spec', { ms: 'latest' }],
      ['a key with a version selector', { 'ms@^2': '2.1.3' }],
      ['a scoped key with a version selector', { '@s/ms@^2': '2.1.3' }],
      ['the self key', { '.': '2.1.3' }],
      ['an overrides value that is a string', 'ms'],
      ['an overrides value that is an array', ['ms']],
      ['an overrides value that is null', null],
      ['one plain and one nested entry', { qs: '6.0.0', ms: { '.': '2.1.3' } }],
    ] as const) {
      it(label, () => {
        expect(ok(entries, overrides)).toBe(false);
      });
    }

    // Without an entry of the overridden name nothing could contradict the
    // override, yet a spec that is no plain string range still cannot be vouched for.
    for (const spec of ['npm:other@2.1.3', 'github:o/ms#v2', 'latest']) {
      it(`${spec}, even when the lockfile has no entry of that name`, () => {
        expect(ok({}, { ms: spec })).toBe(false);
      });
    }
  });

  it('a lockfileVersion 1 own lockfile never locks the manifest, overrides or not', () => {
    const v1Lock = JSON.stringify({ lockfileVersion: 1, dependencies: { left: { version: '1.0.0' }, ms: { version: '2.1.3' } } });
    expect(legacyDroppable(v1Lock, withOverrides({ ms: '2.1.3' }))).toBe(false);
    expect(legacyDroppable(v1Lock, { dependencies: { left: '^1.0.0' } })).toBe(false);
  });

  it('the legacy dependencies mirror of a v2 lockfile is not consulted: npm reads the packages map', () => {
    const lock = (mirror: object) =>
      JSON.stringify({ lockfileVersion: 2, packages: { '': {}, ...leftEntry, 'node_modules/ms': { version: '2.1.3' } }, dependencies: mirror });
    const body = withOverrides({ ms: '2.1.3' });
    expect(legacyDroppable(lock({ left: { version: '1.0.0' }, ms: { version: '2.1.3' } }), body)).toBe(true);
    expect(legacyDroppable(lock({ left: { version: '1.0.0', dependencies: { ms: { version: '2.0.0' } } } }), body)).toBe(true);
  });

  it('overrides do not stop the additions', () => {
    const { m, l } = withLegacy(lockOf({ ...leftEntry, 'node_modules/ms': { version: '2.0.0' } }), withOverrides({ ms: '2.1.3' }));
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(versions(r)).toEqual(['left@1.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('overrides of a manifest that has no lockfile of its own still block (the rule needs a lockfile)', () => {
    const m = { ...manifests(), 'plug/package.json': pkg({ name: 'plug', overrides: { vite: '7.3.5' } }) };
    expect(droppable(m)).toBe(false);
  });
});

describe('npm lock-validity semantics: loose parsing, no includePrerelease', () => {
  const lockOf = (entries: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...entries } });
  const viteLockedAt = (lockVersion: string, spec: string) => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: spec } }) };
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': lockVersion }) };
    return resolve(m, l);
  };

  it('a prerelease install of a stable-range declaration is not narrow and keeps the floor', () => {
    const r = viteLockedAt('7.4.0-beta.1', '^7.3.5');
    expect(versions(r)).toEqual(['vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('control: the stable version of the same range is narrow', () => {
    const r = viteLockedAt('7.4.0', '^7.3.5');
    expect(versions(r)).toEqual(['vite@7.4.0', 'vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(true);
  });

  it('a prerelease of the release the range names is narrow', () => {
    expect(versions(viteLockedAt('7.3.5-beta.2', '^7.3.5-beta.1'))).toEqual(['vite@7.3.5-beta.2', 'vite@8.3.5']);
  });

  it('a lockfile version a loose parse would accept but that is no semver version adds nothing', () => {
    const r = viteLockedAt('07.3.7', '^7.3.5');
    expect(versions(r)).toEqual(['vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });

  it('a range only a loose parse accepts counts as a plain range', () => {
    const r = viteLockedAt('7.3.7', '>=7.3.5beta');
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('a listed dependency is judged loosely, without includePrerelease', () => {
    const body = { dependencies: { a: '^1.0.0' } };
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.2.0-rc.1' } }), body)).toBe(false);
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '1.2.0' } }), body)).toBe(true);
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '01.2.0' } }), body)).toBe(true);
    // A range that only a loose parse reads is still checked, not waved through.
    expect(legacyDroppable(lockOf({ 'node_modules/a': { version: '0.9.0' } }), { dependencies: { a: '>=1.0.0beta' } })).toBe(false);
  });
});

describe('a lockfile entry with an edge to a name the same lockfile has no entry for makes the lockfile unusable', () => {
  const lockOf = (entries: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...entries } });
  // `legacy/` installs left, which depends on vite. The other two lockfiles
  // always hold a vite entry, so an edge the legacy lockfile cannot resolve is
  // not rescued by an entry in another lockfile.
  const withEdge = (entries: Record<string, unknown>, left: object = { dependencies: { vite: '^7.0.0' } }) =>
    legacyDroppable(lockOf({ 'node_modules/left': { version: '1.0.0', ...left }, ...entries }));

  it('positive control: the edge target has a top-level entry', () => {
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } })).toBe(true);
  });

  it('a dependencies edge without any entry of that name: nothing is provable', () => {
    expect(withEdge({})).toBe(false);
  });

  it('an optionalDependencies edge without an entry', () => {
    expect(withEdge({}, { optionalDependencies: { vite: '^7.0.0' } })).toBe(false);
  });

  it('a peerDependencies edge without an entry (a lockfile written with --legacy-peer-deps)', () => {
    expect(withEdge({}, { peerDependencies: { vite: '^7.0.0' } })).toBe(false);
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { peerDependencies: { vite: '^7.0.0' } })).toBe(true);
  });

  it('the edge target installed only nested counts as having an entry', () => {
    expect(withEdge({ 'node_modules/left/node_modules/vite': { version: '6.0.0' } })).toBe(true);
  });

  it('the lockfile is unusable for every name, not only the one the edge asks for', () => {
    const { m, l } = withLegacy(lockOf({ 'node_modules/left': { version: '1.0.0', dependencies: { vite: '^7.0.0' } } }));
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(r.dropSafe('vite', '1.2.3')).toBe(false);
    expect(r.dropSafe('left', '0.9.0')).toBe(false);
  });

  it('a missing edge target other than the dropped name still blocks the drop', () => {
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { dependencies: { ms: '^2.0.0' } })).toBe(false);
  });

  it('an edge in a lockfile of a project that does not declare the name blocks the drop too', () => {
    const m = { ...manifests(), 'other/package.json': pkg({ name: 'other', dependencies: { z: '^1.0.0' } }) };
    const lock = (z: object) => lockOf({ 'node_modules/z': { version: '1.0.0', ...z } });
    expect(droppable(m, { ...locks(), 'other/package-lock.json': lock({}) })).toBe(true);
    expect(droppable(m, { ...locks(), 'other/package-lock.json': lock({ dependencies: { gone: '^1.0.0' } }) })).toBe(false);
  });

  it('the edge of the root entry counts too', () => {
    const lock = (root: object) =>
      JSON.stringify({ lockfileVersion: 3, packages: { '': root, 'node_modules/left': { version: '1.0.0' } } });
    expect(legacyDroppable(lock({ dependencies: { left: '^1.0.0' } }))).toBe(true);
    expect(legacyDroppable(lock({ dependencies: { vite: '^7.0.0' } }))).toBe(false);
    expect(legacyDroppable(lock({ optionalDependencies: { vite: '^7.0.0' } }))).toBe(false);
    expect(legacyDroppable(lock({ peerDependencies: { vite: '^7.0.0' } }))).toBe(false);
  });

  it('the edge of a workspace folder entry counts too', () => {
    expect(withEdge({ 'packages/w': { name: 'w', version: '1.0.0', dependencies: { vite: '^7.0.0' } } }, {})).toBe(false);
  });

  it('the range of an edge is not compared with the version the lockfile holds (an override can make them differ)', () => {
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { dependencies: { vite: '^7.0.0' } })).toBe(true);
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { peerDependencies: { vite: '^7.0.0' } })).toBe(true);
  });

  describe('aliases resolve by key name', () => {
    it('an alias edge whose alias key has an entry is accounted for', () => {
      const entries = { 'node_modules/old-vite': { name: 'vite', version: '7.3.9' } };
      expect(withEdge(entries, { dependencies: { 'old-vite': 'npm:vite@^7.0.0' } })).toBe(true);
    });

    it('an alias edge without an entry makes the lockfile unusable', () => {
      expect(withEdge({}, { dependencies: { 'old-vite': 'npm:vite@^7.0.0' } })).toBe(false);
    });

    it('an edge whose spec is not a string is still an edge', () => {
      expect(withEdge({ 'node_modules/vite': { version: '6.0.0' }, 'node_modules/ms': { version: '2.0.0' } }, { dependencies: { ms: 7 } })).toBe(true);
      expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { dependencies: { ms: 7 } })).toBe(false);
      expect(withEdge({}, { dependencies: { vite: 7 } })).toBe(false);
    });

    it('an alias edge that cannot be parsed makes the lockfile unusable', () => {
      expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { dependencies: { 'old-vite': 'npm:' } })).toBe(false);
    });

    it('an alias entry does not stand in for the real name an edge asks for', () => {
      expect(withEdge({ 'node_modules/old-vite': { name: 'vite', version: '7.3.9' } })).toBe(false);
    });
  });

  describe('edges that need no entry', () => {
    it('an entry the lockfile lists as bundled', () => {
      const bundled = { 'node_modules/left/node_modules/gone': { version: '1.0.0', inBundle: true, dependencies: { vite: '^7.0.0' } } };
      expect(withEdge(bundled, {})).toBe(true);
    });

    it('control: the same entry without the bundled flag, or with a flag that is not true', () => {
      const entry = { version: '1.0.0', dependencies: { vite: '^7.0.0' } };
      expect(withEdge({ 'node_modules/left/node_modules/gone': entry }, {})).toBe(false);
      expect(withEdge({ 'node_modules/left/node_modules/gone': { ...entry, inBundle: false } }, {})).toBe(false);
    });

    it('the peer edges of an entry listed as bundled need no entry either', () => {
      const bundled = { 'node_modules/left/node_modules/gone': { version: '1.0.0', inBundle: true, peerDependencies: { vite: '^7.0.0' } } };
      expect(withEdge(bundled, {})).toBe(true);
    });

    describe('a peer the entry itself marks optional in peerDependenciesMeta', () => {
      const peer = (peerDependenciesMeta: unknown) => withEdge({}, { peerDependencies: { vite: '^7.0.0' }, peerDependenciesMeta });

      it('optional: true needs no entry', () => {
        expect(peer({ vite: { optional: true } })).toBe(true);
      });

      it('anything else does', () => {
        for (const meta of [{ vite: { optional: false } }, { vite: { optional: 'true' } }, { vite: {} }, { vite: true }, { other: { optional: true } }, [], 'vite', null]) {
          expect(peer(meta)).toBe(false);
        }
      });

      it('exempts only itself and only a peer, not a dependency of the same name', () => {
        expect(withEdge({}, { peerDependencies: { vite: '^7.0.0', ms: '^2.0.0' }, peerDependenciesMeta: { vite: { optional: true } } })).toBe(false);
        expect(withEdge({}, { dependencies: { vite: '^7.0.0' }, peerDependenciesMeta: { vite: { optional: true } } })).toBe(false);
      });

      it('is read from the entry that has the peer, not from another entry', () => {
        const other = { 'node_modules/other': { version: '1.0.0', peerDependenciesMeta: { vite: { optional: true } } } };
        expect(withEdge(other, { peerDependencies: { vite: '^7.0.0' } })).toBe(false);
      });
    });

    describe('a name the entry lists in bundleDependencies stays unknown instead of making the lockfile unusable', () => {
      const bundled = (left: object, entries: Record<string, unknown> = {}) => withEdge(entries, left);
      // The other lockfiles install vite 7.3.7 and 8.3.5; the floor 7.3.5 is the question.
      it('a bundled dependencies edge: that name is unknown, other names are still provable', () => {
        const leftBundlingVite = { dependencies: { vite: '^7.0.0' }, bundleDependencies: ['vite'] };
        expect(bundled(leftBundlingVite)).toBe(false);
        const leftBundlingGone = { dependencies: { gone: '^1.0.0' }, bundleDependencies: ['gone'] };
        expect(bundled(leftBundlingGone)).toBe(true);
      });

      it('the bundledDependencies spelling counts too', () => {
        expect(bundled({ dependencies: { gone: '^1.0.0' }, bundledDependencies: ['gone'] })).toBe(true);
        expect(bundled({ dependencies: { vite: '^7.0.0' }, bundledDependencies: ['vite'] })).toBe(false);
      });

      it('optionalDependencies and peerDependencies edges count too', () => {
        expect(bundled({ optionalDependencies: { gone: '^1.0.0' }, bundleDependencies: ['gone'] })).toBe(true);
        expect(bundled({ peerDependencies: { gone: '^1.0.0' }, bundleDependencies: ['gone'] })).toBe(true);
      });

      it('only the listed names: another missing edge still makes the lockfile unusable', () => {
        expect(bundled({ dependencies: { gone: '^1.0.0', other: '^1.0.0' }, bundleDependencies: ['gone'] })).toBe(false);
        expect(bundled({ dependencies: { gone: '^1.0.0' }, bundleDependencies: ['other'] })).toBe(false);
      });

      it('a list that is not an array of names lists nothing', () => {
        for (const list of [true, 'gone', { gone: true }, [7], [null]]) {
          expect(bundled({ dependencies: { gone: '^1.0.0' }, bundleDependencies: list })).toBe(false);
        }
      });

      it('the list of another entry does not exempt this edge', () => {
        const other = { 'node_modules/other': { version: '1.0.0', bundleDependencies: ['gone'] } };
        expect(bundled({ dependencies: { gone: '^1.0.0' } }, other)).toBe(false);
      });

      it('the root entry and a workspace folder entry may list bundled names too', () => {
        const root = (r: object) => JSON.stringify({ lockfileVersion: 3, packages: { '': r, 'node_modules/left': { version: '1.0.0' } } });
        expect(legacyDroppable(root({ dependencies: { gone: '^1.0.0' } }))).toBe(false);
        expect(legacyDroppable(root({ dependencies: { gone: '^1.0.0' }, bundleDependencies: ['gone'] }))).toBe(true);
        expect(withEdge({ 'packages/w': { name: 'w', version: '1.0.0', dependencies: { gone: '^1.0.0' }, bundleDependencies: ['gone'] } }, {})).toBe(true);
      });

      it('an alias edge to a bundled name makes the real package unknown', () => {
        const left = { dependencies: { 'old-vite': 'npm:vite@^7.0.0' }, bundleDependencies: ['old-vite'] };
        expect(bundled(left)).toBe(false);
        expect(bundled({ dependencies: { 'old-gone': 'npm:gone@^1.0.0' }, bundleDependencies: ['old-gone'] })).toBe(true);
      });

      it('a bundled alias edge that cannot be parsed could mean any package: nothing is provable', () => {
        expect(bundled({ dependencies: { 'old-gone': 'npm:' }, bundleDependencies: ['old-gone'] })).toBe(false);
      });

      it('a bundled edge does not hide an edge to the same name in another lockfile entry', () => {
        const entries = { 'node_modules/third': { version: '1.0.0', dependencies: { gone: '^1.0.0' } } };
        expect(bundled({ dependencies: { gone: '^1.0.0' }, bundleDependencies: ['gone'] }, entries)).toBe(false);
      });
    });

    it('a null entry of another name has no edges and does not stop the other names', () => {
      expect(withEdge({ 'node_modules/vite': { version: '6.0.0' }, 'node_modules/gone': null }, {})).toBe(true);
    });

    it('a lockfileVersion 1 lockfile is not provable at all (its requires are not edges npm installs from)', () => {
      const v1Lock = JSON.stringify({ lockfileVersion: 1, dependencies: { left: { version: '1.0.0', requires: { vite: '^7.0.0' } } } });
      expect(legacyDroppable(v1Lock)).toBe(false);
    });
  });

  it('an edge map that is not an object makes the lockfile unreadable: nothing is provable', () => {
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { dependencies: ['vite'] })).toBe(false);
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { optionalDependencies: 'vite' })).toBe(false);
    expect(withEdge({ 'node_modules/vite': { version: '6.0.0' } }, { peerDependencies: ['vite'] })).toBe(false);
  });

  it('a missing edge target does not stop the additions', () => {
    const { m, l } = withLegacy(lockOf({ 'node_modules/left': { version: '1.0.0', dependencies: { vite: '^7.0.0' } } }));
    expect(versions(resolve(m, l))).toEqual(['left@1.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });

  describe('the edges count toward the total node budget', () => {
    // The hub entry has one edge to each of K entries (and K entries): the
    // lockfile holds 2K + 2 nodes (root, hub, K entries, K edges), the two base
    // lockfiles 4 more. K is chosen so the total is exactly the budget; a
    // `selfEdge` adds one more edge (hub to itself, which has an entry).
    const K = (MAX_LOCK_INDEX_NODES - 6) / 2;
    const edgeHeavy = (selfEdge: boolean) => {
      const edges: Record<string, string> = {};
      const packages: Record<string, unknown> = { '': {} };
      for (let j = 0; j < K; j++) {
        edges[`p${j}`] = '*';
        packages[`node_modules/p${j}`] = { version: '1.0.0' };
      }
      if (selfEdge) edges.hub = '*';
      packages['node_modules/hub'] = { version: '1.0.0', dependencies: edges };
      const m = { ...manifests(), 'big/package.json': pkg({ name: 'big' }) };
      const l = { ...locks(), 'big/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages }) };
      return { m, l };
    };

    it('exactly at the budget the lockfile is indexed', () => {
      const { m, l } = edgeHeavy(false);
      expect(droppable(m, l)).toBe(true);
    }, 30_000);

    it('one edge more makes every name not provable', () => {
      const { m, l } = edgeHeavy(true);
      expect(droppable(m, l)).toBe(false);
    }, 30_000);
  });
});

describe('a link or renamed lockfile entry adds nothing', () => {
  const additions = (frontendVite: object) => {
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': frontendVite as never }) };
    return versions(resolve(manifests(), l));
  };

  it('control: a plain entry adds its version', () => {
    expect(additions({ version: '7.3.7' })).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('a link entry that carries a version', () => {
    expect(additions({ link: true, version: '7.3.7', resolved: '../vite-local' })).toEqual(['vite@8.3.5']);
  });

  it('an entry renamed by its name field', () => {
    expect(additions({ name: 'vite-fork', version: '7.3.7' })).toEqual(['vite@8.3.5']);
  });

  it('an entry whose name field repeats its key still adds its version', () => {
    expect(additions({ name: 'vite', version: '7.3.7' })).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('an npm: spec that cannot be split into a name and a range is never narrow', () => {
  // `semver.validRange` in loose mode still reads these as ranges, so only the
  // alias-form check keeps them from counting as a plain declaration.
  for (const spec of ['npm:x||*', 'npm: 7.3.7', 'npm:x || 7.3.7']) {
    it(`${spec}: adds nothing and keeps the floor`, () => {
      const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: spec } }) };
      const r = resolve(m);
      expect(versions(r)).toEqual(['vite@8.3.5']);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    });
  }

  it('control: the same lockfile with a plain range is narrow', () => {
    const r = resolve();
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    expect(r.dropSafe('vite', '7.3.5')).toBe(true);
  });
});

describe('install policy files: .npmrc and packageManager', () => {
  const facts = (npmrcPaths: string[], packageManagerConfigPaths: string[] = []) => ({
    foreignLockfilePaths: [],
    manifestsCapped: false,
    npmrcPaths,
    packageManagerConfigPaths,
  });

  it('positive control: no .npmrc and no packageManager field', () => {
    expect(droppable(manifests(), locks(), { observedTreeFacts: facts([]) })).toBe(true);
  });

  for (const path of ['.npmrc', 'frontend/.npmrc', 'tools/deep/.npmrc']) {
    it(`${path} anywhere in the tree: no drops, the additions stay`, () => {
      const r = resolve(manifests(), locks(), { observedTreeFacts: facts([path]) });
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    });
  }

  it('facts without an .npmrc list count as an .npmrc being present', () => {
    const noList = { foreignLockfilePaths: [], manifestsCapped: false } as unknown as NarrowNpmInputs['observedTreeFacts'];
    const r = resolve(manifests(), locks(), { observedTreeFacts: noList });
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    // Only the drops are blocked: the facts are otherwise usable, so the additions stay.
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  for (const [label, where] of [
    ['a declaring manifest', 'frontend/package.json'],
    ['a manifest that does not declare the name', 'tools/package.json'],
  ] as const) {
    it(`a packageManager field in ${label}: no drops, the additions stay`, () => {
      const m: Files = { ...manifests(), 'tools/package.json': pkg({ name: 'tools' }) };
      const l: Files = { ...locks(), 'tools/package-lock.json': v3({}) };
      expect(droppable(m, l)).toBe(true);
      m[where] = pkg({ ...JSON.parse(m[where]), packageManager: 'yarn@4.1.0' });
      const r = resolve(m, l);
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    });
  }

  for (const path of ['pnpm-workspace.yaml', 'a/.yarnrc.yml', 'tools/deep/.pnpmfile.cjs']) {
    it(`${path} anywhere in the tree: no drops, the additions stay`, () => {
      const r = resolve(manifests(), locks(), { observedTreeFacts: facts([], [path]) });
      expect(r.dropSafe('vite', '7.3.5')).toBe(false);
      expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    });
  }

  it('facts without a package manager config list count as such a file being present', () => {
    const noList = { foreignLockfilePaths: [], manifestsCapped: false, npmrcPaths: [] } as unknown as NarrowNpmInputs['observedTreeFacts'];
    const r = resolve(manifests(), locks(), { observedTreeFacts: noList });
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  describe('devEngines.packageManager pins a package manager like packageManager', () => {
    const withDevEngines = (devEngines: unknown) => ({
      ...manifests(),
      'frontend/package.json': pkg({ name: 'frontend', devEngines, dependencies: { vite: '^7.3.5' } }),
    });

    it('a devEngines.packageManager entry: no drops, the additions stay', () => {
      for (const devEngines of [{ packageManager: { name: 'yarn', version: '4.1.0' } }, { packageManager: [{ name: 'pnpm' }] }, { packageManager: null }]) {
        const r = resolve(withDevEngines(devEngines));
        expect(r.dropSafe('vite', '7.3.5')).toBe(false);
        expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
      }
    });

    it('devEngines without a packageManager entry (a runtime pin) does not block', () => {
      expect(droppable(withDevEngines({ runtime: { name: 'node', version: '>=20' } }))).toBe(true);
      expect(droppable(withDevEngines({}))).toBe(true);
    });

    it('a devEngines that is not an object cannot be read: no drops', () => {
      for (const devEngines of ['yarn', ['packageManager'], null, 3]) {
        expect(droppable(withDevEngines(devEngines))).toBe(false);
      }
    });

    it('in a manifest that does not declare the name', () => {
      const m = { ...manifests(), 'tools/package.json': pkg({ name: 'tools', devEngines: { packageManager: { name: 'bun' } } }) };
      expect(droppable(m, { ...locks(), 'tools/package-lock.json': v3({}) })).toBe(false);
    });
  });

  it('any value of packageManager counts, even an npm one or null', () => {
    for (const value of ['npm@10.8.0', null, '']) {
      const m: Files = { ...manifests(), 'frontend/package.json': pkg({ packageManager: value, dependencies: { vite: '^7.3.5' } }) };
      expect(droppable(m)).toBe(false);
    }
  });
});

describe('cost: one index over all lockfiles, then lookups', () => {
  // 100 separate projects, each declaring 1000 names and holding a lockfile with
  // those 1000 names (100 000 nodes in total, under the node budget). Every name
  // is asked about once. An implementation that rescans every lockfile for every
  // question needs minutes here; the tight timeout (not an assertion on elapsed
  // time) is what pins that the work is one pass plus lookups.
  const PROJECTS = 100;
  const NAMES = 1000;
  const bigRepo = (fillerPerLock = 0) => {
    const m: Files = {};
    const l: Files = {};
    for (let i = 0; i < PROJECTS; i++) {
      const major = (i % 5) + 1;
      const deps: Record<string, string> = {};
      const entries: Record<string, string> = {};
      for (let j = 0; j < NAMES; j++) {
        deps[`pkg-${j}`] = `^${major}.0.0`;
        entries[`node_modules/pkg-${j}`] = `${major}.2.3`;
      }
      for (let j = 0; j < fillerPerLock; j++) entries[`node_modules/filler-${j}`] = '1.0.0';
      m[`p${i}/package.json`] = pkg({ name: `p${i}`, dependencies: deps });
      l[`p${i}/package-lock.json`] = v3(entries);
    }
    return { m, l };
  };

  // The loop yields to the event loop now and then so that the test timeout can
  // fire while a slow implementation is still working (a timer cannot interrupt
  // synchronous code that never yields).
  const yieldToEventLoop = () => new Promise<void>((resolveYield) => setImmediate(resolveYield));

  it('answers every name of 100 projects x 1000 names (floor 1.0.0 is installed nowhere)', async () => {
    const { m, l } = bigRepo();
    const r = resolve(m, l);
    let drops = 0;
    for (let j = 0; j < NAMES; j++) {
      if (r.dropSafe(`pkg-${j}`, '1.0.0')) drops++;
      if (j % 20 === 0) await yieldToEventLoop();
    }
    expect(drops).toBe(NAMES);
    // The version project 0 installs is installed: not droppable.
    expect(r.dropSafe('pkg-0', '1.2.3')).toBe(false);
  }, 4_000);

  it('lockfiles beyond the node budget answer every name quickly with "not provable"', async () => {
    const { m, l } = bigRepo(11_000); // 100 x 12 000 nodes, above the budget
    const r = resolve(m, l);
    let drops = 0;
    for (let j = 0; j < NAMES; j++) {
      if (r.dropSafe(`pkg-${j}`, '1.0.0')) drops++;
      if (j % 20 === 0) await yieldToEventLoop();
    }
    expect(drops).toBe(0);
  }, 20_000);
});

describe('resolveNarrowNpm never throws', () => {
  it('survives inputs of the wrong shape and answers with the baseline', () => {
    const broken = { manifestPaths: null, manifestFiles: null, lockfileFiles: null } as unknown as NarrowNpmInputs;
    const r = resolveNarrowNpm(broken);
    expect(r.additions).toEqual([]);
    expect(r.dropSafe('vite', '7.3.5')).toBe(false);
  });
});

describe('selectForeignLockfilePaths', () => {
  const blobs = (...paths: string[]) => paths.map((path) => ({ path, type: 'blob' }));

  it('finds the six foreign lockfile kinds at any depth', () => {
    expect(
      selectForeignLockfilePaths(
        blobs('yarn.lock', 'a/pnpm-lock.yaml', 'b/c/bun.lock', 'bun.lockb', 'd/npm-shrinkwrap.json', 'e/deno.lock', 'package-lock.json', 'package.json'),
      ),
    ).toEqual(['yarn.lock', 'a/pnpm-lock.yaml', 'b/c/bun.lock', 'bun.lockb', 'd/npm-shrinkwrap.json', 'e/deno.lock']);
  });

  it('matches names case-insensitively and ignores directories named like a lockfile', () => {
    expect(selectForeignLockfilePaths([{ path: 'Yarn.LOCK', type: 'blob' }, { path: 'yarn.lock', type: 'tree' }])).toEqual(['Yarn.LOCK']);
  });

  it('skips vendored, build and fixture directories like the other lockfile selectors', () => {
    expect(selectForeignLockfilePaths(blobs('node_modules/x/yarn.lock', 'tests/fixtures/y/pnpm-lock.yaml', 'dist/bun.lock'))).toEqual([]);
  });
});

describe('selectPackageManagerConfigPaths', () => {
  const blobs = (...paths: string[]) => paths.map((path) => ({ path, type: 'blob' }));

  it('finds pnpm-workspace.yaml, .yarnrc.yml and .pnpmfile.cjs at any depth', () => {
    expect(
      selectPackageManagerConfigPaths(
        blobs('pnpm-workspace.yaml', 'a/.yarnrc.yml', 'b/c/.pnpmfile.cjs', 'package.json', '.yarnrc', 'pnpm-workspace.yml', '.yarnrc.yml.bak', 'yarnrc.yml'),
      ),
    ).toEqual(['pnpm-workspace.yaml', 'a/.yarnrc.yml', 'b/c/.pnpmfile.cjs']);
  });

  it('matches names case-insensitively and ignores directories named like one', () => {
    expect(selectPackageManagerConfigPaths([{ path: 'x/.YarnRC.yml', type: 'blob' }, { path: '.pnpmfile.cjs', type: 'tree' }])).toEqual(['x/.YarnRC.yml']);
  });

  it('skips vendored, build and fixture directories like the lockfile selection', () => {
    expect(selectPackageManagerConfigPaths(blobs('node_modules/x/.yarnrc.yml', 'tests/fixtures/y/pnpm-workspace.yaml', 'dist/.pnpmfile.cjs'))).toEqual([]);
  });
});

describe('selectNpmrcPaths', () => {
  const blobs = (...paths: string[]) => paths.map((path) => ({ path, type: 'blob' }));

  it('finds an .npmrc at any depth', () => {
    expect(selectNpmrcPaths(blobs('.npmrc', 'a/.npmrc', 'b/c/.npmrc', 'package.json', '.npmrc.bak', 'npmrc'))).toEqual(['.npmrc', 'a/.npmrc', 'b/c/.npmrc']);
  });

  it('matches the name case-insensitively and ignores directories called .npmrc', () => {
    expect(selectNpmrcPaths([{ path: 'x/.NPMRC', type: 'blob' }, { path: '.npmrc', type: 'tree' }])).toEqual(['x/.NPMRC']);
  });

  it('skips vendored, build and fixture directories like the other selectors', () => {
    expect(selectNpmrcPaths(blobs('node_modules/x/.npmrc', 'tests/fixtures/y/.npmrc', 'dist/.npmrc'))).toEqual([]);
  });
});
