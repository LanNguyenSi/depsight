/**
 * Synthetic npm repositories for the end-to-end scan tests. Each scenario is a
 * set of repository files (plus read failures / a truncated tree); the
 * expectations live in the test files that import them.
 *
 * The scenarios cover: the repo shape the narrow override targets (separate
 * projects with their own lockfiles), the shapes it must leave alone
 * (workspaces, other package managers' lockfiles, unreadable or unparsable
 * files, aliases, v1 lockfiles, truncated trees), and one negative per
 * condition of the drop rule.
 */
import { pkg, v1, v2, v3, yarn, type Scenario } from './npm-repo-fixture';

// Two separate projects in the narrow shape: frontend installs vite 7.3.7,
// backend 8.3.5; the baseline floor is 7.3.5.
const viteTwoProjectFiles = (): Record<string, string> => ({
  'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
  'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
  'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
  'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
});

export const SCENARIOS: Record<string, Scenario> = {
  viteGoal: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  stalePkgLockPlusYarnLockSameDir: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  yarnSubprojectUnderNpmRoot: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'tools/x/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'tools/x/yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  v1SubprojectPlusV3Subproject: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'a/package-lock.json': v1({ lodash: '4.17.15' }),
      'b/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'b/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  yarnSubprojectPlusNpmSubproject: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'a/yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
      'b/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'b/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  nolockSubprojectPlusTwoLocked: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'b/package.json': pkg({ dependencies: { lodash: '^4.17.20' } }),
      'b/package-lock.json': v3({ 'node_modules/lodash': '4.17.20' }),
      'c/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
    },
  },
  malformedOwnLockPlusGoodOther: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'a/package-lock.json': '{ not json',
      'b/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'b/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  transitiveNestedCopy: {
    files: {
      'package.json': pkg({ dependencies: { glob: '^7.0.0', foo: '1.0.0' } }),
      'package-lock.json': v3({
        'node_modules/glob': '7.2.3',
        'node_modules/foo': '1.0.0',
        'node_modules/foo/node_modules/glob': '7.1.0',
      }),
    },
  },
  workspaceRoot: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({
        'node_modules/lodash': '4.17.21',
        'packages/a/node_modules/lodash': '4.17.15',
        'node_modules/b': { version: '', link: true },
        'packages/b': '1.0.0',
      }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0', b: '*' } }),
      'packages/b/package.json': pkg({ name: 'b', version: '1.0.0', dependencies: { ms: '^2.0.0' } }),
    },
  },
  alias: {
    files: {
      'package.json': pkg({
        dependencies: { h3: 'npm:h3-nightly@^1.0.0', lodash: '^4.0.0' },
        devDependencies: { lodash: '^4.17.0' },
      }),
      'package-lock.json': v3({
        'node_modules/h3': { name: 'h3-nightly', version: '1.5.0' },
        'node_modules/lodash': '4.17.21',
      }),
    },
  },
  ownLockUnreadableGoesToChain: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'x/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'x/package-lock.json': v3({ 'node_modules/lodash': '4.17.15' }),
    },
    fail: ['x/package-lock.json'],
  },
  depAbsentFromOwnLockButOtherManifestResolves: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'b/package.json': pkg({ dependencies: { lodash: '^4.0.0' } }),
      'b/package-lock.json': v3({ 'node_modules/other': '1.0.0' }),
      'c/package.json': pkg({ dependencies: { lodash: '^4.17.20' } }),
      'c/package-lock.json': v3({ 'node_modules/lodash': '4.17.20' }),
    },
  },
  v1RootLockAndV3Sub: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': v1({ lodash: '4.17.10' }),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  staleMemberLockInWorkspace: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'package-lock.json': v3({
        'packages/a/node_modules/lodash': '4.17.15',
        'node_modules/a': { version: '', link: true },
      }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  aliasAndDirectTwoVersions: {
    files: {
      'a/package.json': pkg({ dependencies: { myLodash: 'npm:lodash@^4.17.0' } }),
      'a/package-lock.json': v3({ 'node_modules/myLodash': { name: 'lodash', version: '4.17.15' } }),
      'b/package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'b/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  devDependencyResolvesAgainstOwnLock: {
    files: {
      'a/package.json': pkg({ devDependencies: { vite: '^7.3.5' } }),
      'a/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'b/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'b/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  sameNameInDepsAndDevDepsNoLock: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' }, devDependencies: { lodash: '^4.17.20' } }),
    },
  },
  coveringRootLockResolvesMember: {
    files: {
      'tools/package.json': pkg({ name: 'tools', workspaces: ['x'] }),
      'tools/package-lock.json': v3({ 'x/node_modules/lodash': '4.17.21' }),
      'tools/x/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
    },
  },
  coveringRootWithoutLockGoesToChain: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.15' }),
      'packages/b/package.json': pkg({ name: 'b', dependencies: { lodash: '^4.17.0' } }),
      'packages/b/package-lock.json': v3({ 'node_modules/lodash': '4.17.20' }),
    },
  },
  workspaceDoesNotCoverMember: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['apps/*'] }),
      'package-lock.json': v3({ 'node_modules/lodash': '9.9.9' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.15' }),
    },
  },
  nonMemberNestedInsideMember: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({
        'node_modules/lodash': '4.17.21',
        'node_modules/a': { version: '', link: true },
        'packages/a': { version: '1.0.0' },
      }),
      'packages/a/package.json': pkg({ name: 'a', version: '1.0.0' }),
      'packages/a/examples/demo/package.json': pkg({ name: 'demo', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/examples/demo/package-lock.json': v3({ 'node_modules/lodash': '4.17.10' }),
    },
  },
  nestedWorkspaceRootStaleMemberLock: {
    files: {
      'apps/package.json': pkg({ name: 'apps-root', workspaces: ['packages/*'] }),
      'apps/package-lock.json': v3({
        'packages/a/node_modules/lodash': '4.17.15',
        'node_modules/a': { version: '', link: true },
      }),
      'apps/packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'apps/packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  negatedWorkspaceMember: {
    files: {
      'package.json': pkg({
        name: 'root',
        workspaces: ['packages/*', '!packages/legacy'],
        dependencies: { lodash: '^4.17.21' },
      }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'packages/legacy/package.json': pkg({ name: 'legacy', dependencies: { lodash: '^4.17.0' } }),
      'packages/legacy/package-lock.json': v3({ 'node_modules/lodash': '4.17.10' }),
    },
  },
  orphanAncestorLockNotUsed: {
    files: {
      'package.json': pkg({ name: 'root' }),
      'apps/package-lock.json': v3({ 'web/node_modules/lodash': '4.17.21' }),
      'apps/web/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
    },
  },
  workspaceRootLockUnreadable: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
    fail: ['package-lock.json'],
  },
  memberWithoutOwnLockHoistedRoot: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
    },
  },
  doublestarObjectFormWorkspaces: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: { packages: ['libs/**'] } }),
      'package-lock.json': v3({ 'libs/x/y/node_modules/lodash': '4.17.15' }),
      'libs/x/y/package.json': pkg({ name: 'y', dependencies: { lodash: '^4.17.0' } }),
      'libs/x/y/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  twoNestedCoveringRootsNearestWins: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['apps/packages/*'] }),
      'package-lock.json': v3({ 'apps/packages/a/node_modules/lodash': '4.17.10' }),
      'apps/package.json': pkg({ name: 'apps', workspaces: ['packages/*'] }),
      'apps/package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15' }),
      'apps/packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
    },
  },
  nearestCoveringRootWithoutLockStops: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['apps/packages/*'] }),
      'package-lock.json': v3({ 'apps/packages/a/node_modules/lodash': '4.17.10' }),
      'apps/package.json': pkg({ name: 'apps', workspaces: ['packages/*'] }),
      'apps/packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'apps/packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  unevaluableWorkspacePatternGoesToChain: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/{a,b}'] }),
      'package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  dotDirNotAWorkspaceMember: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['*'] }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      '.config/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      '.config/package-lock.json': v3({ 'node_modules/lodash': '4.17.10' }),
    },
  },
  yarnWorkspaceRootStaleMemberPkgLock: {
    files: {
      'package.json': pkg({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  rootYarnLockAndSubPkgLock: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  yarnLockInAncestorDirWithoutManifest: {
    files: {
      'tools/yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
      'tools/x/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'tools/x/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'other/package.json': pkg({ dependencies: { lodash: '^4.17.20' } }),
      'other/package-lock.json': v3({ 'node_modules/lodash': '4.17.20' }),
    },
  },
  yarnLockInSiblingDirDoesNotVeto: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'b/package.json': pkg({ dependencies: { left: '^1.0.0' } }),
      'b/yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  nonSemverSpecInOneManifest: {
    files: {
      'a/package.json': pkg({ dependencies: { lodash: 'github:lodash/lodash#4.17.4' } }),
      'b/package.json': pkg({ dependencies: { lodash: '^4.17.20' } }),
      'b/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  scopedDepAndScopedAlias: {
    files: {
      'package.json': pkg({ dependencies: { '@babel/core': '^7.0.0', bc: 'npm:@babel/core@^7.1.0' } }),
      'package-lock.json': v3({
        'node_modules/@babel/core': '7.20.0',
        'node_modules/bc': { name: '@babel/core', version: '7.1.2' },
      }),
    },
  },
  blindSameDirPkgLockPlusYarnLock: {
    truncated: true,
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  blindSubdirPkgLockPlusYarnLock: {
    truncated: true,
    files: {
      'package.json': pkg({ name: 'root' }),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'sub/yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  blindAncestorYarnLockVetoes: {
    truncated: true,
    files: {
      'package.json': pkg({ name: 'root' }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  blindNoYarnLockPerManifest: {
    truncated: true,
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.15' }),
    },
  },
  rootProjectPlusSubProject: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'x/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'x/package-lock.json': v3({ 'node_modules/lodash': '4.17.15' }),
    },
  },
  nonMemberNestedUnderMemberLock: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.21' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21', 'node_modules/a': { link: true, resolved: 'packages/a' }, 'packages/a': { version: '1.0.0' } }),
      'packages/a/package.json': pkg({ name: 'a', version: '1.0.0' }),
      'packages/a/examples/demo/package.json': pkg({ name: 'demo', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/examples/demo/package-lock.json': v3({ 'node_modules/lodash': '4.17.10' }),
    },
  },
  nestedWorkspaceRootMemberStaleLock: {
    files: {
      'apps/package.json': pkg({ name: 'apps-root', workspaces: ['packages/*'] }),
      'apps/package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15', 'node_modules/a': { link: true, resolved: 'packages/a' } }),
      'apps/packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'apps/packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  rootManifestUnreadableMemberStaleOwnLock: {
    fail: ['package.json'],
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  negationCancelledByLaterPositive: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/**', '!packages/b/**', 'packages/b/a'] }),
      'package-lock.json': v3({ 'packages/b/a/node_modules/lodash': '4.17.15' }),
      'packages/b/a/package.json': pkg({ name: 'ba', dependencies: { lodash: '^4.17.0' } }),
      'packages/b/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  negationThenExactReinclude: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*', '!packages/legacy', 'packages/legacy'] }),
      'package-lock.json': v3({ 'packages/legacy/node_modules/lodash': '4.17.15' }),
      'packages/legacy/package.json': pkg({ name: 'legacy', dependencies: { lodash: '^4.17.0' } }),
      'packages/legacy/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  pnpmLockPlusTwoStalePkgLocks: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.10' }),
    },
  },
  blindYarnLockReadFails: {
    truncated: true, fail: ['yarn.lock'],
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  blindYarnLockReadFailsWithConflict: {
    truncated: true, fail: ['yarn.lock'],
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21', 'node_modules/x/node_modules/lodash': '4.17.11' }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  observedYarnLockReadFails: {
    fail: ['yarn.lock'],
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21', 'node_modules/x/node_modules/lodash': '4.17.11' }),
      'yarn.lock': yarn([['lodash@^4.17.0', '4.17.15']]),
    },
  },
  workspaceRootNestedInOuterRoot: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['apps'] }),
      'package-lock.json': v3({ 'apps/node_modules/lodash': '4.17.15', 'node_modules/lodash': '4.17.21' }),
      'apps/package.json': pkg({ name: 'apps', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.0' } }),
      'apps/package-lock.json': v3({ 'node_modules/lodash': '4.17.20' }),
    },
  },
  rootLockLacksDepMemberLockHas: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'package-lock.json': v3({ 'node_modules/other': '1.0.0' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  nestedLinkWithoutVersion: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'package-lock.json': v3({ 'packages/a/node_modules/lodash': { link: true }, 'node_modules/lodash': '4.17.21' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: 'file:../../vendor/lodash' } }),
      'packages/b/package.json': pkg({ name: 'b', dependencies: { lodash: '^4.17.0' } }),
    },
  },
  dotSlashWorkspacePattern: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['./packages/*/'] }),
      'package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  rootV1LockWorkspaceMemberV3: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/*'] }),
      'package-lock.json': v1({ lodash: '4.17.15' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  workspacesObjectNohoistOnly: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: { nohoist: ['**'] } }),
      'package-lock.json': v3({ 'packages/a/node_modules/lodash': '4.17.15' }),
      'packages/a/package.json': pkg({ name: 'a', dependencies: { lodash: '^4.17.0' } }),
      'packages/a/package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
    },
  },
  bunLockPlusTwoStalePkgLocks: {
    files: {
      'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'bun.lock': '{}',
      'package-lock.json': v3({ 'node_modules/lodash': '4.17.21' }),
      'sub/package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
      'sub/package-lock.json': v3({ 'node_modules/lodash': '4.17.10' }),
    },
  },

  // ---- the narrow shape: separate projects, each with its own lockfile ----

  // vite installs at 7.3.7 in frontend/ and 8.3.5 in backend/.
  viteTwoProjects: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Counter-check: frontend's lockfile installs exactly the floor 7.3.5, so
  // the baseline entry is installed somewhere and stays.
  viteCounterCheckFloorInstalled: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.5' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Shape of a repo without a root package.json: backend/ has vite only as a
  // transitive dependency (installed 8.3.5, declared nowhere in backend).
  noRootBackendVitePlusFrontendVite: {
    files: {
      'frontend/package.json': pkg({
        name: 'frontend',
        dependencies: { react: '^19.0.0' },
        devDependencies: { vite: '^7.3.5' },
      }),
      'frontend/package-lock.json': v3({
        'node_modules/react': '19.1.0',
        'node_modules/vite': '7.3.7',
      }),
      'backend/package.json': pkg({
        name: 'backend',
        dependencies: { express: '^5.1.0', vitest: '^3.2.0' },
      }),
      'backend/package-lock.json': v3({
        'node_modules/express': '5.1.0',
        'node_modules/vitest': '3.2.4',
        'node_modules/vite': '8.3.5',
      }),
    },
  },
  // Six projects with their own lockfiles; vite resolves to five versions, the
  // floor of the lowest range (5.4.0) is installed nowhere. lodash resolves
  // identically everywhere.
  sixOwnLockProjects: {
    files: {
      'p1/package.json': pkg({ dependencies: { vite: '^7.3.5', lodash: '^4.17.21' } }),
      'p1/package-lock.json': v3({ 'node_modules/vite': '7.3.7', 'node_modules/lodash': '4.17.21' }),
      'p2/package.json': pkg({ dependencies: { vite: '^8.3.0', lodash: '^4.17.21' } }),
      'p2/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'node_modules/lodash': '4.17.21' }),
      'p3/package.json': pkg({ dependencies: { vite: '^8.3.0', lodash: '^4.17.21' } }),
      'p3/package-lock.json': v3({ 'node_modules/vite': '8.3.6', 'node_modules/lodash': '4.17.21' }),
      'p4/package.json': pkg({ devDependencies: { vite: '^5.4.0' }, dependencies: { lodash: '^4.17.21' } }),
      'p4/package-lock.json': v3({ 'node_modules/vite': '5.4.11', 'node_modules/lodash': '4.17.21' }),
      'p5/package.json': pkg({ devDependencies: { vite: '^6.0.0' }, dependencies: { lodash: '^4.17.21' } }),
      'p5/package-lock.json': v3({ 'node_modules/vite': '6.3.0', 'node_modules/lodash': '4.17.21' }),
      'p6/package.json': pkg({ dependencies: { vite: '^8.3.0', lodash: '^4.17.21' } }),
      'p6/package-lock.json': v3({ 'node_modules/vite': '8.3.5', 'node_modules/lodash': '4.17.21' }),
    },
  },
  // A scoped package in two projects.
  scopedPackageTwoProjects: {
    files: {
      'a/package.json': pkg({ dependencies: { '@babel/core': '^7.0.0' } }),
      'a/package-lock.json': v3({ 'node_modules/@babel/core': '7.20.0' }),
      'b/package.json': pkg({ dependencies: { '@babel/core': '^7.22.0' } }),
      'b/package-lock.json': v3({ 'node_modules/@babel/core': '7.26.0' }),
    },
  },
  // lockfileVersion 2 (packages + legacy dependencies mirror) is read like 3.
  viteTwoProjectsLockfileV2: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v2({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v2({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // A project with a root package.json (no workspaces) and a standalone
  // sub-project: the root keeps its own lockfile's version.
  rootProjectAndSubProjectNoWorkspaces: {
    files: {
      'package.json': pkg({ name: 'root', dependencies: { vite: '^8.3.0' } }),
      'package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/docs/package.json': pkg({ name: 'docs', dependencies: { vite: '^7.3.5' } }),
      'tools/docs/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
    },
  },
  // One declaring project is not narrow (no lockfile of its own): nothing is
  // removed, the narrow versions of the other projects are added.
  viteOneProjectWithoutLockfile: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'scripts/package.json': pkg({ dependencies: { vite: '^6.0.0' } }),
    },
  },

  // ---- negative: exactly one drop condition violated (vite fixture) ----

  // Incomplete tree: the git tree comes back truncated.
  negTruncatedTree: {
    truncated: true,
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Incomplete tree: more manifests than the scan reads (cap of 100).
  negManifestListCapped: {
    extraManifests: 100,
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Other package manager: another package manager's lockfile somewhere in the tree.
  negYarnLockElsewhere: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/yarn.lock': yarn([['left-pad@^1.3.0', '1.3.0']]),
    },
  },
  negPnpmLockElsewhere: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    },
  },
  negBunLockElsewhere: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/bun.lock': '{}',
    },
  },
  negBunLockbElsewhere: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/bun.lockb': 'binary',
    },
  },
  negShrinkwrapElsewhere: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/npm-shrinkwrap.json': v3({ 'node_modules/left-pad': '1.3.0' }),
    },
  },
  // Declaring manifest not narrow: a `workspaces` key (here an empty array, which still counts) in an
  // ancestor package.json.
  negWorkspacesKeyInAncestor: {
    files: {
      'package.json': pkg({ name: 'root', private: true, workspaces: [] }),
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: a `workspaces` key in the declaring manifest itself.
  negWorkspacesKeyInSelf: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' }, workspaces: false }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: an ancestor package.json cannot be read (HTTP 500).
  negAncestorManifestReadError: {
    fail: ['package.json'],
    files: {
      'package.json': pkg({ name: 'root', private: true }),
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: an ancestor package.json is not valid JSON.
  negAncestorManifestUnparsable: {
    files: {
      'package.json': '{ "name": "root", "workspaces": ',
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: a manifest elsewhere in the tree cannot be read; it might declare vite.
  negUnrelatedManifestReadError: {
    fail: ['tools/package.json'],
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'tools/package.json': pkg({ dependencies: { vite: '^6.0.0' } }),
    },
  },
  // Declaring manifest not narrow: a declaring manifest without a lockfile of its own.
  negDeclarerWithoutOwnLock: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'ops/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'ops/package-lock.json': v3({ 'node_modules/vite': '8.3.6' }),
    },
  },
  // Declaring manifest not narrow: a declaring manifest's own lockfile is not valid JSON.
  negDeclarerLockUnparsable: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': '{ not json',
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'ops/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'ops/package-lock.json': v3({ 'node_modules/vite': '8.3.6' }),
    },
  },
  // Declaring manifest not narrow: a declaring manifest's own lockfile cannot be read (HTTP 500).
  negDeclarerLockReadError: {
    fail: ['frontend/package-lock.json'],
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'ops/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'ops/package-lock.json': v3({ 'node_modules/vite': '8.3.6' }),
    },
  },
  // Declaring manifest not narrow: a declaring manifest's own lockfile is lockfileVersion 1.
  negDeclarerLockV1: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v1({ vite: '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: the name is only nested in a declaring manifest's own lockfile (no
  // top-level key): no walking down or up.
  negDeclarerLockOnlyNestedKey: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({
        'node_modules/vitest': '3.2.4',
        'node_modules/vitest/node_modules/vite': '7.3.7',
      }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: the version in the lockfile has no digit.
  negDeclarerLockVersionWithoutDigit: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': 'latest' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'ops/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'ops/package-lock.json': v3({ 'node_modules/vite': '8.3.6' }),
    },
  },
  // Declaring manifest not narrow: one declaration is an npm: alias.
  negDeclarationIsAlias: {
    files: {
      'frontend/package.json': pkg({ dependencies: { bundler: 'npm:vite@^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/bundler': { name: 'vite', version: '7.3.7' } }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: one declaration is not a plain semver range (a git spec).
  negDeclarationNotAPlainRange: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: 'github:vitejs/vite#v7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Declaring manifest not narrow: the lockfile version does not satisfy the declared range (stale lock).
  negLockVersionOutsideDeclaredRange: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.0.1' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // Baseline version installed elsewhere: the baseline version (7.3.5) is installed as a nested transitive copy
  // in a lockfile of another project.
  negBaseVersionNestedInOtherLock: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0', vitest: '^3.2.0' } }),
      'backend/package-lock.json': v3({
        'node_modules/vite': '8.3.5',
        'node_modules/vitest': '3.2.4',
        'node_modules/vitest/node_modules/vite': '7.3.5',
      }),
    },
  },
  // Baseline version installed elsewhere: the baseline version is installed under an aliased key of another lockfile.
  negBaseVersionAliasedInOtherLock: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0', 'old-vite': 'npm:vite@7.3.5' } }),
      'backend/package-lock.json': v3({
        'node_modules/vite': '8.3.5',
        'node_modules/old-vite': { name: 'vite', version: '7.3.5' },
      }),
    },
  },
  // Baseline version installed elsewhere: the baseline version is installed in a lockfile with no manifest
  // declaring it (a third project's v1 tree, nested).
  negBaseVersionInOtherV1Lock: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'legacy/package.json': pkg({ dependencies: { vitest: '^0.34.0' } }),
      'legacy/package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: { vitest: { version: '0.34.6', dependencies: { vite: { version: '7.3.5' } } } },
      }),
    },
  },
  // Baseline version installed elsewhere: a lockfile elsewhere cannot be read (HTTP 500); it could install the
  // baseline version.
  negOtherLockReadError: {
    fail: ['legacy/package-lock.json'],
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }),
      'legacy/package-lock.json': v3({ 'node_modules/left': '1.0.0' }),
    },
  },
  // Baseline version installed elsewhere: a lockfile elsewhere is not valid JSON.
  negOtherLockUnparsable: {
    files: {
      'frontend/package.json': pkg({ dependencies: { vite: '^7.3.5' } }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({ dependencies: { vite: '^8.3.0' } }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      'legacy/package.json': pkg({ dependencies: { left: '^1.0.0' } }),
      'legacy/package-lock.json': '{ not json',
    },
  },
  // The crafted `workspaces` value of an earlier ReDoS finding: only its
  // presence is tested, nothing is built from it.
  craftedWorkspacesPattern: {
    files: {
      'package.json': pkg({ name: 'root', workspaces: ['packages/' + 'a*'.repeat(10) + 'zzz'] }),
      'package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      ['packages/' + 'a'.repeat(30) + '/package.json']: pkg({ name: 'member', dependencies: { vite: '^7.3.5' } }),
      ['packages/' + 'a'.repeat(30) + '/package-lock.json']: v3({ 'node_modules/vite': '7.3.7' }),
    },
  },

  // ---- projects that name the package in a field the baseline does not query,
  // or that have no lockfile (vite fixture: frontend 7.3.7, backend 8.3.5) ----

  // An optional dependency on the exact floor, in a project without a lockfile:
  // it installs vite@7.3.5, which the drop proof cannot see.
  negOptionalExactNoLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({ name: 'plugin', optionalDependencies: { vite: '7.3.5' } }),
    },
  },
  negPeerExactNoLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({ name: 'plugin', peerDependencies: { vite: '7.3.5' } }),
    },
  },
  negBundledNoLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({ name: 'plugin', bundleDependencies: ['vite'] }),
    },
  },
  // The project has a lockfile that installs the floor: the baseline entry stays.
  negOptionalExactWithLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({ name: 'plugin', optionalDependencies: { vite: '7.3.5' } }),
      'plugin/package-lock.json': v3({ 'node_modules/vite': '7.3.5' }),
    },
  },
  // A project without a lockfile that only pins vite through `overrides` while
  // depending on something that pulls it in.
  negOverridesNoLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({
        name: 'plugin',
        dependencies: { vitest: '^3.0.0' },
        overrides: { vite: '7.3.5' },
      }),
    },
  },
  // A project that does not mention vite at all and has no lockfile.
  negUnrelatedProjectNoLock: {
    files: {
      ...viteTwoProjectFiles(),
      'tools/package.json': pkg({ name: 'tools', dependencies: { left: '^1.0.0' } }),
    },
  },
  // A root package.json without a lockfile next to two locked projects.
  negRootManifestNoLock: {
    files: {
      ...viteTwoProjectFiles(),
      'package.json': pkg({ name: 'root', private: true }),
    },
  },
  // The same project with a lockfile of its own: nothing blocks the drop.
  optionalSatisfiedWithLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({ name: 'plugin', optionalDependencies: { vite: '>=7 <9' } }),
      'plugin/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
    },
  },
  peerSatisfiedWithLock: {
    files: {
      ...viteTwoProjectFiles(),
      'plugin/package.json': pkg({ name: 'plugin', peerDependencies: { vite: '^7.0.0 || ^8.0.0' } }),
      'plugin/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  },
  // An excluded directory (build output) is not read at all, so its manifest
  // does not count as a lockless project.
  vendoredManifestNotRead: {
    files: {
      ...viteTwoProjectFiles(),
      'node_modules/vite-fork/package.json': pkg({ name: 'vite-fork', dependencies: { vite: '7.3.5' } }),
    },
  },

  // ---- an extra project `extra/` next to the two vite projects whose lockfile
  // or manifest holds something the drop proof must not read as "installs
  // nothing". Each of these keeps the baseline floor (vite 7.3.5). ----

  // lockfileVersion 1 entry for vite installed from a git URL, nested under a
  // regular dependency: the version is not semver, so what it installs is unknown.
  negV1GitVersionTransitive: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          x: {
            version: '1.0.0',
            dependencies: { vite: { version: 'github:vitejs/vite#abc123', from: 'github:vitejs/vite' } },
          },
        },
      }),
    },
  },
  negV1TarballVersionTransitive: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: { x: { version: '1.0.0', dependencies: { vite: { version: 'https://example.com/vite.tgz' } } } },
      }),
    },
  },
  negV1FileVersionTransitive: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': JSON.stringify({
        lockfileVersion: 1,
        dependencies: { x: { version: '1.0.0', dependencies: { vite: { version: 'file:../vite-fork' } } } },
      }),
    },
  },
  // A lockfileVersion 3 entry for a nested vite without a version (only a git `resolved`).
  negV3EntryWithoutVersion: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': v3({
        'node_modules/x': '1.0.0',
        'node_modules/x/node_modules/vite': { resolved: 'git+ssh://git@github.com/vitejs/vite.git#abc' },
      }),
    },
  },
  // A lockfileVersion 3 entry that is a string, not an object.
  negV3EntryNotAnObject: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/x': { version: '1.0.0' }, 'node_modules/x/node_modules/vite': '7.3.5' },
      }),
    },
  },
  negUnknownLockfileVersion: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': JSON.stringify({ lockfileVersion: 4, installs: { 'x/vite': '7.3.5' } }),
    },
  },
  negLockfileVersion3WithoutPackages: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': JSON.stringify({ lockfileVersion: 3 }),
    },
  },
  // A stale own lockfile that lacks a declared dependency: npm installs that
  // dependency (and what it pulls in) fresh.
  negStaleLockMissingDeclaredDep: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': v3({}),
    },
  },
  negStaleLockOneDepAddedLater: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { ms: '^2.0.0', x: '^1.0.0' } }),
      'extra/package-lock.json': v3({ 'node_modules/ms': '2.1.3' }),
    },
  },
  negStaleLockRangeUnsatisfied: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^2.0.0' } }),
      'extra/package-lock.json': v3({
        'node_modules/x': '1.0.0',
        'node_modules/x/node_modules/vite': '7.3.6',
      }),
    },
  },
  negStaleLockMissingDevDep: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', devDependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': v3({}),
    },
  },
  negStaleLockMissingOptionalDep: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', optionalDependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': v3({}),
    },
  },
  // The same shape in a lockfileVersion 1 own lockfile.
  negStaleV1LockMissingDeclaredDep: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' } }),
      'extra/package-lock.json': v1({}),
    },
  },
  // The extra project's lockfile is complete: nothing blocks the drop.
  extraProjectCompleteLock: {
    files: {
      ...viteTwoProjectFiles(),
      'extra/package.json': pkg({ name: 'extra', dependencies: { x: '^1.0.0' }, devDependencies: { y: 'github:o/y#v1' } }),
      'extra/package-lock.json': v3({ 'node_modules/x': '1.2.0', 'node_modules/y': { version: '1.0.0', resolved: 'git+ssh://x' } }),
    },
  },
  // An `.npmrc` anywhere (it can switch the lockfile off or change the registry).
  negNpmrcInProject: {
    files: { ...viteTwoProjectFiles(), 'frontend/.npmrc': 'package-lock=false\n' },
  },
  negNpmrcAtRoot: {
    files: { ...viteTwoProjectFiles(), '.npmrc': 'registry=https://registry.example.com/\n' },
  },
  // A `packageManager` field in any manifest (corepack pins another manager).
  negPackageManagerYarnField: {
    files: {
      ...viteTwoProjectFiles(),
      'frontend/package.json': pkg({ name: 'frontend', packageManager: 'yarn@4.1.0', dependencies: { vite: '^7.3.5' } }),
    },
  },
  negPackageManagerInUnrelatedManifest: {
    files: {
      ...viteTwoProjectFiles(),
      'tools/package.json': pkg({ name: 'tools', packageManager: 'npm@10.8.0' }),
      'tools/package-lock.json': v3({}),
    },
  },
  // An `.npmrc` in a vendored directory is not read, like the manifests there.
  vendoredNpmrcNotRead: {
    files: { ...viteTwoProjectFiles(), 'node_modules/vite-fork/.npmrc': 'package-lock=false\n' },
  },
};
