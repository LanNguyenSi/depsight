/**
 * Synthetic npm workspace repositories for the end-to-end narrow override
 * tests (tests/unit/osv-narrow-workspaces.test.ts). Each is the git tree and
 * file contents the mocked GitHub client serves.
 *
 * The goal shape: a root package.json with `workspaces: ["packages/*"]`, two
 * members and one root package-lock.json written the way npm writes it (the
 * root entry records the `workspaces` value, each member has a folder entry
 * and a `node_modules/<name>` link entry). vite is installed at 7.3.7 at the
 * top level and as a transitive 6.4.0 under vitest, so the repo-wide chain
 * finds no single resolution and queries the floor 7.0.0 of member b's range,
 * which no lockfile installs. Every other scenario changes one thing.
 */
import { pkg, v1, type Scenario } from './npm-repo-fixture';

type Packages = Record<string, unknown>;

const WS = ['packages/*'];
const ROOT_DEV = { vite: '^7.3.5', vitest: '^3.2.0' };
const rootBody = (extra: object = {}) => ({ name: 'root', private: true, workspaces: WS, devDependencies: ROOT_DEV, ...extra });
const memberA = (extra: object = {}) => ({ name: 'a', version: '1.0.0', dependencies: { vite: '^7.3.5', b: '^1.0.0' }, ...extra });
const memberB = (extra: object = {}) => ({ name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0' }, ...extra });

const goalPackages = (): Packages => ({
  '': { name: 'root', workspaces: WS, devDependencies: ROOT_DEV },
  'node_modules/a': { resolved: 'packages/a', link: true },
  'node_modules/b': { resolved: 'packages/b', link: true },
  'node_modules/vite': { version: '7.3.7' },
  'node_modules/vitest': { version: '3.2.4', dependencies: { vite: '^6.0.0' } },
  'node_modules/vitest/node_modules/vite': { version: '6.4.0' },
  'packages/a': { name: 'a', version: '1.0.0', dependencies: { vite: '^7.3.5', b: '^1.0.0' } },
  'packages/b': { name: 'b', version: '1.0.0', dependencies: { vite: '^7.0.0' } },
});
const lock = (packages: Packages, lockfileVersion = 3) => JSON.stringify({ lockfileVersion, requires: true, packages });
const editedLock = (edit: (p: Packages) => void) => {
  const p = goalPackages();
  edit(p);
  return lock(p);
};

const goalFiles = (): Record<string, string> => ({
  'package.json': pkg(rootBody()),
  'package-lock.json': lock(goalPackages()),
  'packages/a/package.json': pkg(memberA()),
  'packages/b/package.json': pkg(memberB()),
});

export const WORKSPACE_SCENARIOS: Record<string, Scenario> = {
  wsGoal: { files: goalFiles() },
  wsLockfileVersion2: {
    files: { ...goalFiles(), 'package-lock.json': JSON.stringify({ lockfileVersion: 2, packages: goalPackages(), dependencies: {} }) },
  },
  wsObjectFormWorkspaces: {
    files: {
      ...goalFiles(),
      'package.json': pkg(rootBody({ workspaces: { packages: WS } })),
      'package-lock.json': editedLock((p) => (p[''] = { name: 'root', workspaces: { packages: WS }, devDependencies: ROOT_DEV })),
    },
  },
  wsNestedRootBesideStandalone: {
    files: {
      'package.json': pkg({ name: 'top', private: true }),
      'package-lock.json': lock({ '': { name: 'top' } }),
      'ws/package.json': pkg(rootBody()),
      'ws/package-lock.json': lock(goalPackages()),
      'ws/packages/a/package.json': pkg(memberA()),
      'ws/packages/b/package.json': pkg(memberB()),
      'app/package.json': pkg({ name: 'app', dependencies: { vite: '^8.3.0' } }),
      'app/package-lock.json': lock({ '': { name: 'app' }, 'node_modules/vite': { version: '8.3.5' } }),
    },
  },
  wsRootLockV1: {
    files: { ...goalFiles(), 'package-lock.json': v1({ vite: '7.3.7', vitest: '3.2.4' }) },
  },
  wsNoRootLock: {
    files: (() => {
      const f = goalFiles();
      delete f['package-lock.json'];
      return f;
    })(),
  },
  wsRootLockReadError: { files: goalFiles(), fail: ['package-lock.json'] },
  wsWorkspacesNotRecorded: {
    files: { ...goalFiles(), 'package-lock.json': editedLock((p) => (p[''] = { name: 'root', devDependencies: ROOT_DEV })) },
  },
  wsWorkspacesRecordedStale: {
    files: {
      ...goalFiles(),
      'package-lock.json': editedLock((p) => (p[''] = { name: 'root', workspaces: ['packages/*', 'tools/*'], devDependencies: ROOT_DEV })),
    },
  },
  wsMemberNotInLock: {
    files: { ...goalFiles(), 'packages/c/package.json': pkg({ name: 'c', version: '1.0.0', dependencies: { vite: '^7.3.0' } }) },
  },
  wsMemberLinkMissing: {
    files: { ...goalFiles(), 'package-lock.json': editedLock((p) => delete p['node_modules/b']) },
  },
  wsMemberManifestReadError: { files: goalFiles(), fail: ['packages/b/package.json'] },
  wsLinkOutsideRepo: {
    files: {
      ...goalFiles(),
      'package-lock.json': editedLock((p) => {
        p['node_modules/shared'] = { resolved: '../shared', link: true };
        p['../shared'] = { name: 'shared', version: '1.0.0' };
      }),
    },
  },
  wsNestedWorkspaceRoots: {
    files: { ...goalFiles(), 'packages/a/package.json': pkg(memberA({ workspaces: ['plugins/*'] })) },
  },
  wsMemberAlias: {
    files: {
      ...goalFiles(),
      'packages/b/package.json': pkg(memberB({ dependencies: { myvite: 'npm:vite@^7.0.0' } })),
      'package-lock.json': editedLock((p) => {
        p['node_modules/myvite'] = { name: 'vite', version: '7.3.7' };
        p['packages/b'] = { name: 'b', version: '1.0.0', dependencies: { myvite: 'npm:vite@^7.0.0' } };
      }),
    },
  },
  wsMemberNestedCopy: {
    files: { ...goalFiles(), 'package-lock.json': editedLock((p) => (p['packages/b/node_modules/vite'] = { version: '7.3.6' })) },
  },
  wsMemberPeer: {
    files: {
      ...goalFiles(),
      'packages/b/package.json': pkg(memberB({ dependencies: {}, peerDependencies: { vite: '^7.0.0' } })),
      'package-lock.json': editedLock((p) => (p['packages/b'] = { name: 'b', version: '1.0.0', peerDependencies: { vite: '^7.0.0' } })),
    },
  },
  wsMemberOptional: {
    files: {
      ...goalFiles(),
      'packages/b/package.json': pkg(memberB({ dependencies: {}, optionalDependencies: { vite: '^7.0.0' } })),
      'package-lock.json': editedLock((p) => (p['packages/b'] = { name: 'b', version: '1.0.0', optionalDependencies: { vite: '^7.0.0' } })),
    },
  },
  wsMemberRangeNotSatisfied: {
    files: { ...goalFiles(), 'packages/b/package.json': pkg(memberB({ dependencies: { vite: '^8.0.0' } })) },
  },
  wsMemberLinkVersionMismatch: {
    files: { ...goalFiles(), 'packages/b/package.json': pkg(memberB({ version: '1.1.0' })) },
  },
  wsMemberOverrides: {
    files: { ...goalFiles(), 'packages/b/package.json': pkg(memberB({ overrides: { vite: '7.3.7' } })) },
  },
  wsNpmrc: { files: { ...goalFiles(), '.npmrc': 'package-lock=false\n' } },
};
