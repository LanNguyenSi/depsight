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
    observedTreeFacts: { foreignLockfilePaths: [], manifestsCapped: false },
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
      observedTreeFacts: { foreignLockfilePaths: [], manifestsCapped: true },
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
  ]) {
    it(`${path} anywhere: no narrow resolution at all`, () => {
      const r = resolve(manifests(), locks(), {
        observedTreeFacts: { foreignLockfilePaths: [path], manifestsCapped: false },
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

  it('a prerelease of a later minor inside a prerelease-bounded caret range is narrow', () => {
    const m = { ...manifests(), 'frontend/package.json': pkg({ dependencies: { vite: '^7.0.0-beta.1' } }) };
    const l = { ...locks(), 'frontend/package-lock.json': v3({ 'node_modules/vite': '7.1.0-beta.2' }) };
    expect(versions(resolve(m, l))).toEqual(['vite@7.1.0-beta.2', 'vite@8.3.5']);
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

  it('install in a v1 dependencies tree (nested)', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { vitest: '^0.34.0' } }) };
    const l = {
      ...locks(),
      'legacy/package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: { vitest: { version: '0.34.6', dependencies: { vite: { version: '7.3.5' } } } },
      }),
    };
    expect(droppable(m, l)).toBe(false);
  });

  it('install through a v1 alias version (npm:vite@7.3.5)', () => {
    const m = { ...manifests(), 'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }) };
    const l = {
      ...locks(),
      'legacy/package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: { 'old-vite': { version: 'npm:vite@7.3.5' } },
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

  it('an equal version string that is not valid semver still counts as installed', () => {
    const l = { ...locks(), 'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'node_modules/x/node_modules/vite': '7.3' }) };
    expect(droppable(manifests(), l, undefined, '7.3')).toBe(false);
    expect(droppable(manifests(), l, undefined, '7.4')).toBe(true);
  });

  // The node budget is one total across all fetched lockfiles. `withNodes(total)`
  // adds projects (no dependencies) whose lockfiles hold exactly `total` nodes
  // together, in chunks far below the budget, on top of the 4 nodes of the base
  // fixture. A `packages` map counts its root entry too; a v1 tree does not.
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
        const dependencies: Record<string, unknown> = {};
        for (let j = 0; j < nodes; j++) dependencies[`p${j}`] = { version: '1.0.0' };
        l[`big${i}/package-lock.json`] = JSON.stringify({ lockfileVersion: 1, dependencies });
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

  it('finds the five foreign lockfile kinds at any depth', () => {
    expect(
      selectForeignLockfilePaths(
        blobs('yarn.lock', 'a/pnpm-lock.yaml', 'b/c/bun.lock', 'bun.lockb', 'd/npm-shrinkwrap.json', 'package-lock.json', 'package.json'),
      ),
    ).toEqual(['yarn.lock', 'a/pnpm-lock.yaml', 'b/c/bun.lock', 'bun.lockb', 'd/npm-shrinkwrap.json']);
  });

  it('matches names case-insensitively and ignores directories named like a lockfile', () => {
    expect(selectForeignLockfilePaths([{ path: 'Yarn.LOCK', type: 'blob' }, { path: 'yarn.lock', type: 'tree' }])).toEqual(['Yarn.LOCK']);
  });

  it('skips vendored, build and fixture directories like the other lockfile selectors', () => {
    expect(selectForeignLockfilePaths(blobs('node_modules/x/yarn.lock', 'tests/fixtures/y/pnpm-lock.yaml', 'dist/bun.lock'))).toEqual([]);
  });
});
