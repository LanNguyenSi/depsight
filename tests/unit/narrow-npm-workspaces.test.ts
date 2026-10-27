/**
 * Unit tests for the npm workspace part of the narrow lockfile override
 * (lib/manifest-discovery.ts, task b031d380): workspace membership comes from
 * the root package-lock.json (its folder and `link: true` entries), never from
 * the `workspaces` patterns.
 *
 * Part 1 enumerates the truth tables of the two pure predicates
 * (`provenWorkspaceFolders`, `workspaceMemberLockKey`) against expectations
 * written as plain boolean logic, not by calling the code under test.
 *
 * Part 2 drives `resolveNarrowNpm` on a workspace fixture. The fixture is
 * droppable as it stands (the positive control pins that), and every negative
 * test breaks exactly one thing and expects the drop to turn false:
 *
 *   root `package.json` (workspaces `packages/*`, devDependencies vite ^7.3.5
 *   and vitest ^3.2.0), members `packages/a` (vite ^7.3.5, member b ^1.0.0) and
 *   `packages/b` (vite ^7.0.0); one root `package-lock.json` with vite 7.3.7 at
 *   the top level and a transitive vite 6.4.0 under vitest. The baseline floor
 *   7.0.0 (b's range) is installed nowhere.
 *
 * Part 3 feeds adversarial lockfiles (huge maps, `..` keys, absolute paths,
 * backslashes, links outside the repository, duplicate names) and bounds the
 * time.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_LOCK_INDEX_NODES,
  provenWorkspaceFolders,
  resolveNarrowNpm,
  workspaceMemberLockKey,
  type NarrowNpmInputs,
} from '@/lib/manifest-discovery';
import { pkg } from './helpers/npm-repo-fixture';

type Files = Record<string, string>;
type Packages = Record<string, unknown>;

// ---- part 1: truth tables of the pure predicates ------------------------------

describe('provenWorkspaceFolders: truth table', () => {
  // Ten independent conditions. Each is true in the fixture and has one
  // representative way to be false; every combination is built and checked.
  const DIMENSIONS = [
    'lockShape', // lockfileVersion 3 with a packages map (false: lockfileVersion 1)
    'rootEntry', // the root entry "" is an object (false: absent)
    'patterns', // the package.json value is an npm shape (false: an empty array, recorded as is)
    'recorded', // the root entry records the same value (false: another pattern list)
    'folderEntry', // the folder has an entry of its own (false: absent)
    'linkEntry', // node_modules/<name> exists (false: absent)
    'linkResolves', // the link resolves to exactly the folder (false: a trailing slash)
    'noStrayLink', // no other link entry (false: a link to a folder that is no candidate)
    'cleanFolder', // the folder is a clean relative path (false: it holds a `..` segment)
    'linkableName', // the name addresses one node_modules entry (false: a name with `..`)
  ] as const;
  type Dim = (typeof DIMENSIONS)[number];

  const build = (on: Record<Dim, boolean>) => {
    const folder = on.cleanFolder ? 'packages/a' : 'packages/x/../a';
    const name = on.linkableName ? 'a' : '../a';
    const pkgWorkspaces = on.patterns ? ['packages/*'] : [];
    const recorded = on.recorded ? pkgWorkspaces : ['packages/*', 'tools/*'];
    const packages: Packages = {};
    if (on.rootEntry) packages[''] = { name: 'root', workspaces: recorded };
    if (on.folderEntry) packages[folder] = { name, version: '1.0.0' };
    if (on.linkEntry) packages[`node_modules/${name}`] = { resolved: on.linkResolves ? folder : `${folder}/`, link: true };
    if (!on.noStrayLink) {
      packages['node_modules/tool'] = { resolved: 'tools/tool', link: true };
      packages['tools/tool'] = { version: '1.0.0' };
    }
    const lock = on.lockShape ? { lockfileVersion: 3, packages } : { lockfileVersion: 1, dependencies: {} };
    return { pkgWorkspaces, lock, folder, name };
  };

  // The expectation, from the rule alone: the lockfile proves something only
  // with a known shape, a root entry, an npm pattern value recorded unchanged,
  // and every link entry resolving to a proven folder. The candidate is proven
  // when its folder entry and its link resolving to it both exist and its
  // folder and name are clean. Its own link counts as a link entry: when the
  // candidate is not proven, that link resolves to an unproven folder.
  const expected = (on: Record<Dim, boolean>): string[] | null => {
    const lockOk = on.lockShape && on.rootEntry && on.patterns && on.recorded;
    const memberProven = on.folderEntry && on.linkEntry && on.linkResolves && on.cleanFolder && on.linkableName;
    const linksAccounted = on.noStrayLink && (!on.linkEntry || memberProven);
    if (!lockOk || !linksAccounted) return null;
    return memberProven ? [on.cleanFolder ? 'packages/a' : 'packages/x/../a'] : [];
  };

  const combos: Array<Record<Dim, boolean>> = [];
  for (let bits = 0; bits < 1 << DIMENSIONS.length; bits++) {
    combos.push(Object.fromEntries(DIMENSIONS.map((d, i) => [d, (bits & (1 << i)) !== 0])) as Record<Dim, boolean>);
  }

  it(`matches the rule on all ${1 << DIMENSIONS.length} combinations`, () => {
    const mismatches: string[] = [];
    let proven = 0;
    let empty = 0;
    for (const on of combos) {
      const { pkgWorkspaces, lock, folder, name } = build(on);
      const got = provenWorkspaceFolders(pkgWorkspaces, lock, [{ folder, name }]);
      const want = expected(on);
      const gotList = got === null ? null : [...got];
      if (JSON.stringify(gotList) !== JSON.stringify(want)) mismatches.push(`${JSON.stringify(on)} got ${JSON.stringify(gotList)} want ${JSON.stringify(want)}`);
      if (want !== null && want.length === 1) proven++;
      if (want !== null && want.length === 0) empty++;
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    // non-vacuous: all three outcomes occur
    expect(proven).toBe(1);
    expect(empty).toBeGreaterThan(0);
  });

  it('each condition alone, with all others true, decides the outcome', () => {
    const all = Object.fromEntries(DIMENSIONS.map((d) => [d, true])) as Record<Dim, boolean>;
    const { pkgWorkspaces, lock, folder, name } = build(all);
    expect([...(provenWorkspaceFolders(pkgWorkspaces, lock, [{ folder, name }]) ?? [])]).toEqual(['packages/a']);
    for (const d of DIMENSIONS) {
      const on = { ...all, [d]: false };
      const b = build(on);
      const got = provenWorkspaceFolders(b.pkgWorkspaces, b.lock, [{ folder: b.folder, name: b.name }]);
      expect(got === null ? null : [...got], d).toEqual(expected(on));
      expect(got === null || got.size === 0, `${d} false must not prove the member`).toBe(true);
    }
  });
});

describe('provenWorkspaceFolders: the variants of each condition', () => {
  const okPackages = (): Packages => ({
    '': { name: 'root', workspaces: ['packages/*'] },
    'node_modules/a': { resolved: 'packages/a', link: true },
    'packages/a': { name: 'a', version: '1.0.0' },
  });
  const prove = (packages: Packages, extra: { workspaces?: unknown; folder?: string; name?: unknown; lock?: unknown } = {}) => {
    const lock = 'lock' in extra ? extra.lock : { lockfileVersion: 3, packages };
    const got = provenWorkspaceFolders('workspaces' in extra ? extra.workspaces : ['packages/*'], lock, [
      { folder: extra.folder ?? 'packages/a', name: 'name' in extra ? extra.name : 'a' },
    ]);
    return got === null ? null : [...got];
  };

  it('positive control, version 2 and 3', () => {
    expect(prove(okPackages())).toEqual(['packages/a']);
    expect(provenWorkspaceFolders(['packages/*'], { lockfileVersion: 2, packages: okPackages(), dependencies: {} }, [{ folder: 'packages/a', name: 'a' }])).toEqual(new Set(['packages/a']));
  });

  it('a lockfile of another shape proves nothing', () => {
    for (const lock of [null, 'x', [], {}, { lockfileVersion: 1, packages: okPackages() }, { lockfileVersion: 4, packages: okPackages() }, { lockfileVersion: '3', packages: okPackages() }, { lockfileVersion: 3 }, { lockfileVersion: 3, packages: [] }]) {
      expect(prove(okPackages(), { lock }), JSON.stringify(lock)).toBeNull();
    }
  });

  it('a root entry that is not an object proves nothing', () => {
    for (const root of [undefined, null, 'root', []]) {
      const packages = okPackages();
      if (root === undefined) delete packages[''];
      else packages[''] = root;
      expect(prove(packages)).toBeNull();
    }
  });

  it('a package.json workspaces value npm does not read (or does not record) proves nothing, even when recorded the same', () => {
    for (const value of [[], false, null, 'packages/*', {}, { packages: [] }, { nohoist: ['x'] }, [1], ['packages/*', 2], { packages: 'packages/*' }]) {
      const packages = okPackages();
      packages[''] = { name: 'root', workspaces: value };
      expect(prove(packages, { workspaces: value }), JSON.stringify(value)).toBeNull();
    }
  });

  it('the object form proves when recorded the same', () => {
    const value = { packages: ['packages/*'], nohoist: ['**/x'] };
    const packages = okPackages();
    packages[''] = { name: 'root', workspaces: value };
    expect(prove(packages, { workspaces: value })).toEqual(['packages/a']);
  });

  it('a recorded value that differs in any way proves nothing (stale lockfile)', () => {
    for (const recorded of [undefined, ['packages/*', 'tools/*'], ['packages/**'], ['./packages/*'], { packages: ['packages/*'] }, 'packages/*', ['packages/*', '!packages/a']]) {
      const packages = okPackages();
      packages[''] = recorded === undefined ? { name: 'root' } : { name: 'root', workspaces: recorded };
      expect(prove(packages), JSON.stringify(recorded)).toBeNull();
    }
  });

  it('the patterns are compared, never evaluated: a lockfile that records them proves its own entries', () => {
    // packages/a does not match `apps/*`; only the lockfile's entries count.
    const packages = okPackages();
    packages[''] = { name: 'root', workspaces: ['apps/*'] };
    expect(prove(packages, { workspaces: ['apps/*'] })).toEqual(['packages/a']);
  });

  it('the folder entry must be an object, not a link, not extraneous, and named like the member when it names one', () => {
    for (const entry of [undefined, null, '1.0.0', { name: 'b', version: '1.0.0' }, { version: '1.0.0', link: true }, { version: '1.0.0', link: false }, { version: '1.0.0', extraneous: true }]) {
      const packages = okPackages();
      if (entry === undefined) delete packages['packages/a'];
      else packages['packages/a'] = entry;
      // the member's own link then resolves to an unproven folder
      expect(prove(packages), JSON.stringify(entry)).toBeNull();
    }
    const unnamed = okPackages();
    unnamed['packages/a'] = { version: '1.0.0' };
    expect(prove(unnamed)).toEqual(['packages/a']);
  });

  it('the link must be `link: true`, not extraneous, and resolve to exactly the folder', () => {
    for (const link of [
      { resolved: 'packages/a', link: 'true' },
      { resolved: 'packages/a', link: 1 },
      { resolved: 'packages/a', link: true, extraneous: true },
      { resolved: 'packages/a/', link: true },
      { resolved: './packages/a', link: true },
      { resolved: '/packages/a', link: true },
      { resolved: '/repo/packages/a', link: true },
      { resolved: 'packages\\a', link: true },
      { resolved: 'packages/x/../a', link: true },
      { resolved: 'Packages/a', link: true },
      { resolved: '../repo/packages/a', link: true },
      { link: true },
      { resolved: ['packages/a'], link: true },
    ]) {
      const packages = okPackages();
      packages['node_modules/a'] = link;
      expect(prove(packages), JSON.stringify(link)).toBeNull();
    }
    // a link that is not a link entry at all leaves the member unproven
    for (const link of [undefined, null, { resolved: 'packages/a' }, { resolved: 'packages/a', link: false }, { version: '1.0.0' }]) {
      const packages = okPackages();
      if (link === undefined) delete packages['node_modules/a'];
      else packages['node_modules/a'] = link;
      expect(prove(packages), JSON.stringify(link)).toEqual([]);
    }
  });

  it('every other link entry must resolve to a proven folder', () => {
    for (const [key, entry] of [
      ['node_modules/shared', { resolved: '../shared', link: true }],
      ['node_modules/abs', { resolved: '/etc', link: true }],
      ['node_modules/self', { resolved: '', link: true }],
      ['node_modules/tool', { resolved: 'tools/tool', link: true }],
      ['packages/a/node_modules/tool', { resolved: 'tools/tool', link: true }],
      ['node_modules/odd', { resolved: 'packages/a', link: 'yes' }],
      ['node_modules/nores', { link: true }],
    ] as Array<[string, unknown]>) {
      const packages = okPackages();
      packages[key] = entry;
      expect(prove(packages), key).toBeNull();
    }
    // a second link to the proven folder is accounted for
    const twice = okPackages();
    twice['node_modules/alias-of-a'] = { resolved: 'packages/a', link: true };
    twice['packages/b/node_modules/a'] = { resolved: 'packages/a', link: true };
    expect(prove(twice)).toEqual(['packages/a']);
  });

  it('a folder that is no clean relative path is never proven', () => {
    for (const folder of ['', '/packages/a', 'packages//a', './packages/a', 'packages/./a', 'packages/../a', '..', 'packages\\a', 'packages/node_modules/a', 'packages/Node_Modules/a']) {
      const packages: Packages = {
        '': { name: 'root', workspaces: ['packages/*'] },
        'node_modules/a': { resolved: folder, link: true },
        [folder]: { name: 'a', version: '1.0.0' },
      };
      expect(prove(packages, { folder }), JSON.stringify(folder)).toBeNull();
    }
  });

  it('a name that does not address one node_modules entry is never proven', () => {
    for (const name of [undefined, null, 1, '', '.a', '..', '../a', 'a/b', '@scope', '@/a', '@scope/', '@scope/.a', '@scope/a/b', 'a\\b', 'node_modules', '@node_modules/a']) {
      const packages: Packages = {
        '': { name: 'root', workspaces: ['packages/*'] },
        [`node_modules/${String(name)}`]: { resolved: 'packages/a', link: true },
        'packages/a': { version: '1.0.0' },
      };
      expect(prove(packages, { name }), JSON.stringify(name)).toBeNull();
    }
    const scoped: Packages = {
      '': { name: 'root', workspaces: ['packages/*'] },
      'node_modules/@scope/a': { resolved: 'packages/a', link: true },
      'packages/a': { name: '@scope/a', version: '1.0.0' },
    };
    expect(prove(scoped, { name: '@scope/a' })).toEqual(['packages/a']);
  });

  it('own properties only: __proto__ and constructor keys are not looked up on the prototype', () => {
    const packages = JSON.parse('{"": {"workspaces": ["packages/*"]}, "__proto__": {"version": "1.0.0"}, "node_modules/__proto__": {"resolved": "__proto__", "link": true}}');
    expect([...(provenWorkspaceFolders(['packages/*'], { lockfileVersion: 3, packages }, [{ folder: '__proto__', name: '__proto__' }]) ?? [])]).toEqual(['__proto__']);
    const missing = { '': { workspaces: ['packages/*'] } };
    expect([...(provenWorkspaceFolders(['packages/*'], { lockfileVersion: 3, packages: missing }, [{ folder: 'constructor', name: 'constructor' }]) ?? ['x'])]).toEqual([]);
  });

  it('a lockfile above the entry budget proves nothing', () => {
    const packages: Packages = okPackages();
    for (let i = 0; i <= MAX_LOCK_INDEX_NODES; i++) packages[`node_modules/f${i}`] = { version: '1.0.0' };
    expect(prove(packages)).toBeNull();
  });
});

describe('workspaceMemberLockKey: truth table', () => {
  // own: <folder>/node_modules/vite; between: <parent>/node_modules/vite for a
  // parent folder of the member; hoisted: node_modules/vite (its presence never
  // changes the answer, which names the key npm resolves from).
  for (const folder of ['a', 'packages/a', 'packages/group/a']) {
    for (const own of [false, true]) {
      for (const between of [false, true]) {
        for (const hoisted of [false, true]) {
          const parents = folder.split('/').slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join('/'));
          if (between && parents.length === 0) continue;
          it(`${folder}: own ${own}, between ${between}, hoisted ${hoisted}`, () => {
            const packages: Packages = {};
            if (own) packages[`${folder}/node_modules/vite`] = { version: '7.3.6' };
            if (between) packages[`${parents[parents.length - 1]}/node_modules/vite`] = { version: '7.3.5' };
            if (hoisted) packages['node_modules/vite'] = { version: '7.3.7' };
            const want = own ? `${folder}/node_modules/vite` : between ? null : 'node_modules/vite';
            expect(workspaceMemberLockKey(packages, folder, 'vite')).toBe(want);
          });
        }
      }
    }
  }

  it('every parent folder is checked, not only the nearest', () => {
    expect(workspaceMemberLockKey({ 'packages/node_modules/vite': {} }, 'packages/group/a', 'vite')).toBeNull();
    expect(workspaceMemberLockKey({ 'packages/group/node_modules/vite': {} }, 'packages/group/a', 'vite')).toBeNull();
  });

  it('a key of another name, a deeper copy or a sibling folder does not count', () => {
    const packages = {
      'packages/a/node_modules/vitest/node_modules/vite': {},
      'packages/b/node_modules/vite': {},
      'packages/a/node_modules/vite-plugin': {},
      'packages/ab/node_modules/vite': {},
    };
    expect(workspaceMemberLockKey(packages, 'packages/a', 'vite')).toBe('node_modules/vite');
  });

  it('scoped names', () => {
    expect(workspaceMemberLockKey({ 'packages/a/node_modules/@s/x': {} }, 'packages/a', '@s/x')).toBe('packages/a/node_modules/@s/x');
    expect(workspaceMemberLockKey({}, 'packages/a', '@s/x')).toBe('node_modules/@s/x');
  });

  it('own properties only', () => {
    const packages = JSON.parse('{"__proto__": {}}');
    expect(workspaceMemberLockKey(packages, 'packages/a', 'constructor')).toBe('node_modules/constructor');
  });
});

// ---- part 2: the workspace shape through resolveNarrowNpm ---------------------

function inputs(manifests: Files, locks: Files, overrides: Partial<NarrowNpmInputs> = {}): NarrowNpmInputs {
  return {
    manifestPaths: Object.keys(manifests),
    manifestFiles: Object.entries(manifests).map(([path, content]) => ({ path, content })),
    lockfileFiles: Object.entries(locks).map(([path, content]) => ({ path, content })),
    observedLockfilePaths: { npm: Object.keys(locks), yarn: [] },
    observedTreeFacts: { foreignLockfilePaths: [], manifestsCapped: false, npmrcPaths: [], packageManagerConfigPaths: [] },
    ...overrides,
  };
}

const WS = ['packages/*'];
const ROOT_DEV = { vite: '^7.3.5', vitest: '^3.2.0' };
const rootManifest = (extra: object = {}) => ({ name: 'root', private: true, workspaces: WS, devDependencies: ROOT_DEV, ...extra });
const memberA = (extra: object = {}) => ({ name: 'a', version: '1.0.0', dependencies: { vite: '^7.3.5', b: '^1.0.0' }, ...extra });
const memberB = (extra: object = {}) => ({ name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0' }, ...extra });

const manifests = (): Files => ({
  'package.json': pkg(rootManifest()),
  'packages/a/package.json': pkg(memberA()),
  'packages/b/package.json': pkg(memberB()),
});
const lockPackages = (): Packages => ({
  '': { name: 'root', workspaces: WS, devDependencies: ROOT_DEV },
  'node_modules/a': { resolved: 'packages/a', link: true },
  'node_modules/b': { resolved: 'packages/b', link: true },
  'node_modules/vite': { version: '7.3.7' },
  'node_modules/vitest': { version: '3.2.4', dependencies: { vite: '^6.0.0' } },
  'node_modules/vitest/node_modules/vite': { version: '6.4.0' },
  'packages/a': { name: 'a', version: '1.0.0', dependencies: { vite: '^7.3.5', b: '^1.0.0' } },
  'packages/b': { name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0' } },
});
const lockOf = (packages: Packages, lockfileVersion = 3) => JSON.stringify({ lockfileVersion, requires: true, packages });
const locks = (packages: Packages = lockPackages()): Files => ({ 'package-lock.json': lockOf(packages) });

const resolve = (m: Files = manifests(), l: Files = locks(), o: Partial<NarrowNpmInputs> = {}) => resolveNarrowNpm(inputs(m, l, o));
const droppable = (m?: Files, l?: Files, o?: Partial<NarrowNpmInputs>, version = '7.0.0') => resolve(m, l, o).dropSafe('vite', version);
const versions = (r: ReturnType<typeof resolveNarrowNpm>) => r.additions.map((a) => `${a.name}@${a.version}`).sort();
const withPackages = (edit: (p: Packages) => void): Files => {
  const p = lockPackages();
  edit(p);
  return locks(p);
};
const withManifest = (path: string, body: object): Files => ({ ...manifests(), [path]: pkg(body) });

describe('workspace: positive control', () => {
  it('drops the floor no lockfile installs and adds the hoisted version every declarer resolves', () => {
    const r = resolve();
    expect(r.dropSafe('vite', '7.0.0')).toBe(true);
    expect(r.dropSafe('vite', '7.3.5')).toBe(true);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vitest@3.2.4']);
  });

  it('keeps every version some entry installs (hoisted, nested transitive)', () => {
    const r = resolve();
    expect(r.dropSafe('vite', '7.3.7')).toBe(false);
    expect(r.dropSafe('vite', '6.4.0')).toBe(false);
  });

  it('never drops or adds a member name (the baseline never queries it)', () => {
    const r = resolve();
    expect(r.dropSafe('b', '1.0.0')).toBe(false);
    expect(versions(r).some((v) => v.startsWith('a@') || v.startsWith('b@'))).toBe(false);
  });

  it('lockfileVersion 2 like 3', () => {
    expect(droppable(manifests(), { 'package-lock.json': JSON.stringify({ lockfileVersion: 2, packages: lockPackages(), dependencies: {} }) })).toBe(true);
  });

  it('a nested workspace root below a plain root package.json, beside a standalone project', () => {
    const m: Files = {
      'package.json': pkg({ name: 'top', private: true }),
      'ws/package.json': pkg(rootManifest()),
      'ws/packages/a/package.json': pkg(memberA()),
      'ws/packages/b/package.json': pkg(memberB()),
      'app/package.json': pkg({ name: 'app', dependencies: { vite: '^8.3.0' } }),
    };
    const l: Files = {
      'package-lock.json': lockOf({ '': { name: 'top' } }),
      'ws/package-lock.json': lockOf(lockPackages()),
      'app/package-lock.json': lockOf({ '': { name: 'app' }, 'node_modules/vite': { version: '8.3.5' } }),
    };
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(true);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vite@8.3.5', 'vitest@3.2.4']);
  });

  it('the root alone (no member manifest) whose lockfile records its workspaces', () => {
    const m = { 'package.json': pkg(rootManifest()) };
    const l = withPackages((p) => {
      for (const k of ['node_modules/a', 'node_modules/b', 'packages/a', 'packages/b']) delete p[k];
    });
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.3.5')).toBe(true);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vitest@3.2.4']);
  });

  it('a member dependency on another member, linked: its version must satisfy the range', () => {
    // positive control: b is 1.0.0, a declares ^1.0.0
    expect(droppable()).toBe(true);
    expect(droppable(withManifest('packages/a/package.json', memberA({ dependencies: { vite: '^7.3.5', b: '^2.0.0' } })))).toBe(false);
    expect(droppable(withManifest('packages/a/package.json', memberA({ dependencies: { vite: '^7.3.5', b: '*' } })))).toBe(true);
    // a spec that is no range only needs the entry
    expect(droppable(withManifest('packages/a/package.json', memberA({ dependencies: { vite: '^7.3.5', b: 'file:../b' } })))).toBe(true);
  });

  it('the linked member version comes from its package.json and must equal the lockfile folder entry', () => {
    expect(droppable(withManifest('packages/b/package.json', memberB({ version: '1.1.0' })))).toBe(false);
    expect(droppable(manifests(), withPackages((p) => (p['packages/b'] = { name: 'b', version: '1.1.0', dependencies: { vite: '^7.0.0' } })))).toBe(false);
    for (const version of [undefined, '', 'one', 1]) {
      const m = withManifest('packages/b/package.json', { name: 'b', version, dependencies: { vite: '^7.0.0' } });
      const l = withPackages((p) => (p['packages/b'] = { name: 'b', version, dependencies: { vite: '^7.0.0' } }));
      expect(droppable(m, l), JSON.stringify(version)).toBe(false);
    }
  });

  it('the root depending on a member through a link follows the same rule', () => {
    const m = withManifest('package.json', rootManifest({ dependencies: { a: '^1.0.0' } }));
    expect(droppable(m)).toBe(true);
    const wrong = withManifest('package.json', rootManifest({ dependencies: { a: '^2.0.0' } }));
    expect(droppable(wrong)).toBe(false);
  });

  it('a link under another name than the member it resolves to does not satisfy a range', () => {
    const m = withManifest('packages/a/package.json', memberA({ dependencies: { vite: '^7.3.5', bee: '^1.0.0' } }));
    const l = withPackages((p) => (p['node_modules/bee'] = { resolved: 'packages/b', link: true }));
    expect(droppable(m, l)).toBe(false);
  });

  it('a member that lists a dependency in range under its own folder is locked; that name keeps its floor, others drop', () => {
    const m = withManifest('packages/a/package.json', memberA({ dependencies: { vite: '^7.3.5', b: '^1.0.0', ms: '^2.0.0' } }));
    const l = withPackages((p) => {
      p['packages/a/node_modules/ms'] = { version: '2.1.3' };
      p['packages/a'] = { name: 'a', version: '1.0.0', dependencies: { vite: '^7.3.5', b: '^1.0.0', ms: '^2.0.0' } };
    });
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(true);
    expect(r.dropSafe('ms', '2.0.0')).toBe(false);
  });

  it('dependencies and devDependencies of a member both take part', () => {
    const m = withManifest('packages/b/package.json', memberB({ dependencies: {}, devDependencies: { vite: '^7.0.0' } }));
    const l = withPackages((p) => (p['packages/b'] = { name: 'b', version: '1.0.0', devDependencies: { vite: '^7.0.0' } }));
    expect(droppable(m, l)).toBe(true);
  });
});

describe('workspace: what the root lockfile cannot prove keeps the floor', () => {
  it('root lockfile of lockfileVersion 1', () => {
    const l = { 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { vite: { version: '7.3.7' } } }) };
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    expect(versions(r)).toEqual([]);
  });

  it('no root lockfile', () => {
    const r = resolve(manifests(), {});
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    expect(versions(r)).toEqual([]);
  });

  it('a root lockfile that was observed but not read, or does not parse', () => {
    const files = inputs(manifests(), locks());
    files.lockfileFiles = [];
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.0.0')).toBe(false);
    expect(resolveNarrowNpm(files).additions).toEqual([]);
    expect(droppable(manifests(), { 'package-lock.json': '{ not json' })).toBe(false);
  });

  it('the lockfile does not record the workspaces (no additions from the workspace either)', () => {
    const l = withPackages((p) => (p[''] = { name: 'root', devDependencies: ROOT_DEV }));
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    expect(versions(r)).toEqual([]);
  });

  it('the lockfile records other workspaces (stale)', () => {
    const l = withPackages((p) => (p[''] = { name: 'root', workspaces: ['packages/*', 'tools/*'], devDependencies: ROOT_DEV }));
    expect(droppable(manifests(), l)).toBe(false);
  });

  it('the package.json workspaces value is not one npm reads, even when the lockfile records the same value', () => {
    for (const value of [[], false, null, 'packages/*', { nohoist: ['x'] }, { packages: [] }]) {
      const m = withManifest('package.json', rootManifest({ workspaces: value }));
      const l = withPackages((p) => (p[''] = { name: 'root', workspaces: value, devDependencies: ROOT_DEV }));
      const r = resolve(m, l);
      expect(r.dropSafe('vite', '7.0.0'), JSON.stringify(value)).toBe(false);
      expect(versions(r), JSON.stringify(value)).toEqual([]);
    }
  });

  it('a member the lockfile does not list (a folder entry or its link missing)', () => {
    expect(droppable(manifests(), withPackages((p) => delete p['packages/b']))).toBe(false);
    expect(droppable(manifests(), withPackages((p) => delete p['node_modules/b']))).toBe(false);
    const third = { ...manifests(), 'packages/c/package.json': pkg({ name: 'c', version: '1.0.0', dependencies: { left: '^1.0.0' } }) };
    expect(droppable(third)).toBe(false);
  });

  it('a member not listed does not stop the others adding their versions', () => {
    const third = { ...manifests(), 'packages/c/package.json': pkg({ name: 'c', version: '1.0.0', dependencies: { vite: '^7.3.5' } }) };
    expect(versions(resolve(third))).toEqual(['vite@7.3.7', 'vitest@3.2.4']);
  });

  it('a link that resolves elsewhere, a folder entry of another name, a link to an unread folder', () => {
    expect(droppable(manifests(), withPackages((p) => (p['node_modules/b'] = { resolved: 'packages/b/', link: true })))).toBe(false);
    expect(droppable(manifests(), withPackages((p) => (p['packages/b'] = { name: 'bee', version: '1.0.0', dependencies: { vite: '^7.0.0' } })))).toBe(false);
    const stray = withPackages((p) => {
      p['node_modules/tool'] = { resolved: 'tools/tool', link: true };
      p['tools/tool'] = { version: '1.0.0' };
    });
    expect(droppable(manifests(), stray)).toBe(false);
  });

  it('a member without a name, or named so that no link can address it', () => {
    expect(droppable(withManifest('packages/b/package.json', { version: '1.0.0', dependencies: { vite: '^7.0.0' } }))).toBe(false);
    expect(droppable(withManifest('packages/b/package.json', memberB({ name: '../b' })))).toBe(false);
  });

  it('two members of the same name: the one the link does not resolve to is unproven', () => {
    const m = { ...manifests(), 'packages/b2/package.json': pkg(memberB()) };
    expect(droppable(m)).toBe(false);
  });

  it('a manifest below the root that is no member (a nested project with its own lockfile)', () => {
    const m = { ...manifests(), 'packages/a/examples/demo/package.json': pkg({ name: 'demo', dependencies: { vite: '^7.3.5' } }) };
    const l = { ...locks(), 'packages/a/examples/demo/package-lock.json': lockOf({ '': {}, 'node_modules/vite': { version: '7.3.7' } }) };
    expect(droppable(m, l)).toBe(false);
  });

  it('nested workspace roots: a member with a workspaces key of its own', () => {
    const m = withManifest('packages/a/package.json', memberA({ workspaces: ['plugins/*'] }));
    expect(droppable(m)).toBe(false);
  });

  it('an unread package.json at or above a member', () => {
    const files = inputs(manifests(), locks());
    files.manifestFiles = files.manifestFiles.filter((f) => f.path !== 'packages/b/package.json');
    expect(resolveNarrowNpm(files).dropSafe('vite', '7.0.0')).toBe(false);
    const rootUnread = inputs(manifests(), locks());
    rootUnread.manifestFiles = rootUnread.manifestFiles.filter((f) => f.path !== 'package.json');
    expect(resolveNarrowNpm(rootUnread).dropSafe('vite', '7.0.0')).toBe(false);
    expect(resolveNarrowNpm(rootUnread).additions).toEqual([]);
  });
});

describe('workspace: declarations the drop proof does not vouch for keep the floor', () => {
  it('an alias declaration in a member', () => {
    const m = withManifest('packages/b/package.json', memberB({ dependencies: { myvite: 'npm:vite@^7.0.0' } }));
    const l = withPackages((p) => {
      p['node_modules/myvite'] = { name: 'vite', version: '7.3.7' };
      p['packages/b'] = { name: 'b', version: '1.0.0', dependencies: { myvite: 'npm:vite@^7.0.0' } };
    });
    expect(droppable(m, l)).toBe(false);
  });

  it('a copy under the member folder (members install different versions)', () => {
    const l = withPackages((p) => (p['packages/b/node_modules/vite'] = { version: '7.3.6' }));
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    // b is still locked: its vite resolves in range from its own folder; only vite keeps its floor
    expect(r.dropSafe('vitest', '3.2.0')).toBe(true);
    // b's copy is not added (the baseline queries it as a lockfile copy of the name)
    expect(versions(r)).toEqual(['vite@7.3.7', 'vitest@3.2.4']);
  });

  it('a copy in a folder between the member and the root', () => {
    const m = {
      ...manifests(),
      'packages/group/c/package.json': pkg({ name: 'c', version: '1.0.0', dependencies: { vite: '^7.0.0' } }),
    };
    const l = withPackages((p) => {
      p['node_modules/c'] = { resolved: 'packages/group/c', link: true };
      p['packages/group/c'] = { name: 'c', version: '1.0.0', dependencies: { vite: '^7.0.0' } };
      p['packages/group/node_modules/vite'] = { version: '7.3.6' };
    });
    const r = resolve(m, l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    // the member resolves nothing it can vouch for: not locked, so no name drops
    expect(r.dropSafe('vitest', '3.2.0')).toBe(false);
    // control: the same member without the copy between
    const l2 = withPackages((p) => {
      p['node_modules/c'] = { resolved: 'packages/group/c', link: true };
      p['packages/group/c'] = { name: 'c', version: '1.0.0', dependencies: { vite: '^7.0.0' } };
    });
    expect(resolve(m, l2).dropSafe('vite', '7.0.0')).toBe(true);
  });

  for (const field of ['optionalDependencies', 'peerDependencies'] as const) {
    it(`${field} in a member blocks the drop and adds nothing`, () => {
      const m = withManifest('packages/b/package.json', memberB({ dependencies: {}, [field]: { vite: '^7.0.0' } }));
      const l = withPackages((p) => (p['packages/b'] = { name: 'b', version: '1.0.0', [field]: { vite: '^7.0.0' } }));
      const r = resolve(m, l);
      expect(r.dropSafe('vite', '7.0.0')).toBe(false);
      expect(versions(r)).toEqual(['vite@7.3.7', 'vitest@3.2.4']);
    });

    it(`${field} in the root blocks the drop`, () => {
      const m = withManifest('package.json', rootManifest({ [field]: { vite: '^7.0.0' } }));
      expect(droppable(m)).toBe(false);
    });
  }

  for (const field of ['bundleDependencies', 'bundledDependencies'] as const) {
    it(`${field} naming the package in a member blocks the drop`, () => {
      const m = withManifest('packages/b/package.json', memberB({ [field]: ['vite'] }));
      expect(droppable(m)).toBe(false);
    });
  }

  it('a member whose range the hoisted version does not satisfy (no copy of its own): not locked, nothing drops', () => {
    const m = withManifest('packages/b/package.json', memberB({ dependencies: { vite: '^8.0.0' } }));
    const r = resolve(m);
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    expect(r.dropSafe('vitest', '3.2.0')).toBe(false);
  });

  it('a member dependency the lockfile does not list at all: not locked', () => {
    const m = withManifest('packages/b/package.json', memberB({ dependencies: { vite: '^7.0.0', left: '^1.0.0' } }));
    expect(droppable(m)).toBe(false);
  });

  it('a member with overrides (any value) is not locked', () => {
    for (const overrides of [{ vite: '7.3.7' }, {}, { vite: { '.': '7.3.7' } }]) {
      expect(droppable(withManifest('packages/b/package.json', memberB({ overrides }))), JSON.stringify(overrides)).toBe(false);
    }
  });

  it('root overrides are checked against the whole root lockfile, member folders included', () => {
    expect(droppable(withManifest('package.json', rootManifest({ overrides: { vite: '^7.3.0' } })))).toBe(false); // 6.4.0 nested
    const reflected = withPackages((p) => (p['node_modules/vitest/node_modules/vite'] = { version: '7.3.6' }));
    expect(droppable(withManifest('package.json', rootManifest({ overrides: { vite: '^7.3.0' } })), reflected)).toBe(true);
  });

  it('the root declaring vite outside its range of the hoisted version: not locked', () => {
    expect(droppable(withManifest('package.json', rootManifest({ devDependencies: { vite: '^8.0.0', vitest: '^3.2.0' } })))).toBe(false);
  });

  it('a stray lockfile of a member counts as installed but proves nothing', () => {
    const l = { ...locks(), 'packages/b/package-lock.json': lockOf({ '': {}, 'node_modules/vite': { version: '7.0.0' } }) };
    const r = resolve(manifests(), l);
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    expect(r.dropSafe('vite', '7.3.5')).toBe(true);
    expect(versions(r)).toEqual(['vite@7.3.7', 'vitest@3.2.4']);
  });

  it('the general conditions still apply: an .npmrc, a foreign lockfile, a truncated tree', () => {
    const facts = { foreignLockfilePaths: [], manifestsCapped: false, npmrcPaths: [], packageManagerConfigPaths: [] };
    expect(droppable(manifests(), locks(), { observedTreeFacts: { ...facts, npmrcPaths: ['.npmrc'] } })).toBe(false);
    expect(droppable(manifests(), locks(), { observedTreeFacts: { ...facts, foreignLockfilePaths: ['yarn.lock'] } })).toBe(false);
    expect(droppable(manifests(), locks(), { observedLockfilePaths: null })).toBe(false);
    expect(droppable(withManifest('packages/a/package.json', memberA({ packageManager: 'npm@10.8.0' })))).toBe(false);
  });

  it('an edge of a member folder entry to a name the lockfile has no entry for makes the lockfile unusable', () => {
    expect(droppable(manifests(), withPackages((p) => (p['packages/b'] = { name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0', gone: '^1.0.0' } })))).toBe(false);
  });
});

// ---- part 3: adversarial lockfiles ---------------------------------------------

describe('workspace: adversarial lockfiles never widen a drop', () => {
  it('`..` keys, absolute keys and backslash keys that spell a member folder do not prove it', () => {
    for (const folderKey of ['packages/x/../b', '/packages/b', 'packages\\b', './packages/b', 'packages/b/.']) {
      const l = withPackages((p) => {
        delete p['packages/b'];
        p[folderKey] = { name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0' } };
        p['node_modules/b'] = { resolved: folderKey, link: true };
      });
      expect(droppable(manifests(), l), folderKey).toBe(false);
    }
  });

  it('a member folder whose git path holds a backslash is never proven', () => {
    const m = { 'package.json': pkg(rootManifest()), 'packages/a\\b/package.json': pkg(memberB()) };
    const l = withPackages((p) => {
      for (const k of ['node_modules/a', 'node_modules/b', 'packages/a', 'packages/b']) delete p[k];
      p['packages/a\\b'] = { name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0' } };
      p['node_modules/b'] = { resolved: 'packages/a\\b', link: true };
    });
    expect(droppable(m, l)).toBe(false);
  });

  it('links outside the repository or to the root', () => {
    for (const resolved of ['../outside', '../../etc', '/tmp/x', '', '.', 'C:\\x']) {
      const l = withPackages((p) => {
        p['node_modules/outside'] = { resolved, link: true };
        p[resolved || 'x'] = { version: '1.0.0' };
      });
      expect(droppable(manifests(), l), resolved).toBe(false);
    }
  });

  it('a link of another member name to a proven folder neither proves a second member nor hides one', () => {
    const m = { ...manifests(), 'packages/c/package.json': pkg({ name: 'c', version: '1.0.0', dependencies: { vite: '^7.0.0' } }) };
    const l = withPackages((p) => (p['node_modules/c'] = { resolved: 'packages/b', link: true }));
    expect(droppable(m, l)).toBe(false);
  });

  it('duplicate JSON keys: the last one wins, as for npm', () => {
    const text = lockOf(lockPackages()).replace('"node_modules/b":{"resolved":"packages/b","link":true}', '"node_modules/b":{"resolved":"packages/b","link":true},"node_modules/b":{"resolved":"elsewhere","link":true}');
    expect(text).toContain('elsewhere');
    expect(droppable(manifests(), { 'package-lock.json': text })).toBe(false);
  });

  it('a huge packages map: answered quickly and as for the small one', () => {
    const FILLER = 300_000;
    const p = lockPackages();
    for (const k of ['node_modules/a', 'node_modules/b', 'packages/a', 'packages/b']) delete p[k];
    for (let i = 0; i < FILLER; i++) p[`node_modules/f${i}`] = { version: '1.0.0' };
    const m: Files = { 'package.json': pkg(rootManifest()) };
    for (let i = 0; i < 60; i++) {
      const name = `m${i}`;
      m[`packages/${name}/package.json`] = pkg({ name, version: '1.0.0', dependencies: { vite: '^7.0.0' } });
      p[`node_modules/${name}`] = { resolved: `packages/${name}`, link: true };
      p[`packages/${name}`] = { name, version: '1.0.0', dependencies: { vite: '^7.0.0' } };
    }
    const l = locks(p);
    const started = performance.now();
    const r = resolve(m, l);
    let drops = 0;
    for (let i = 0; i < 2000; i++) if (r.dropSafe('vite', `7.0.${i % 2 === 0 ? 0 : 1}`)) drops++;
    const elapsed = performance.now() - started;
    expect(drops).toBe(2000);
    expect(r.dropSafe('vite', '7.3.7')).toBe(false);
    // One pass per lockfile plus lookups: well under this bound (measured
    // locally at a few hundred milliseconds, most of it JSON parsing).
    expect(elapsed).toBeLessThan(8_000);
  }, 20_000);

  it('a root lockfile beyond the node budget proves no member', () => {
    const p = lockPackages();
    for (let i = 0; i <= MAX_LOCK_INDEX_NODES; i++) p[`node_modules/f${i}`] = { version: '1.0.0' };
    const r = resolve(manifests(), locks(p));
    expect(r.dropSafe('vite', '7.0.0')).toBe(false);
    expect(versions(r)).toEqual([]);
  }, 30_000);
});
