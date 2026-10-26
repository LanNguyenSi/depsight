/**
 * End-to-end scenarios for the narrow npm lockfile override.
 *
 * Every scenario runs the REAL pipeline (detectEcosystem -> collectDeps -> OSV
 * querybatch) on a synthetic repository (tests/unit/helpers/npm-scenarios.ts);
 * only the GitHub client and `fetch` are mocked. Each test asserts the EXACT
 * set of OSV queries (`name@version`).
 *
 * The expectations are written against `base`: the query set the code before
 * the narrow override produced for the same repository (measured by running
 * this scenario table against a clean checkout of origin/master 4809d52, not
 * assumed). Two kinds of scenario:
 *
 *   same(base)    outside the narrow shape: the result must EQUAL base. These
 *                 are workspaces, other package managers' lockfiles, v1,
 *                 malformed or unreadable files, aliases, truncated trees and
 *                 the other shapes earlier reviews found under-reporting in.
 *   narrow({...}) the narrow shape: the result is base minus `dropped` plus
 *                 `added`. A dropped entry is a version installed by no
 *                 lockfile of the repository (`why` names the reason); an
 *                 added entry is a version a manifest's own lockfile installs.
 *
 * The invariant checked for every scenario: no base entry is lost unless it is
 * listed as dropped.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { runScan } from './helpers/npm-repo-fixture';
import { SCENARIOS } from './helpers/npm-scenarios';

interface Expectation {
  /** Query set of the code before the narrow override (measured). */
  base: string[];
  dropped: string[];
  added: string[];
  why?: string;
}

const same = (base: string[]): Expectation => ({ base, dropped: [], added: [] });
const narrow = (e: Expectation): Expectation => e;

const EXPECTED: Record<string, Expectation> = {
  // ---- head == base: the scenario is outside the narrow shape ----
  stalePkgLockPlusYarnLockSameDir: same(['lodash@4.17.0']),
  yarnSubprojectUnderNpmRoot: same(['lodash@4.17.0']),
  yarnSubprojectPlusNpmSubproject: same(['lodash@4.17.0']),
  malformedOwnLockPlusGoodOther: same(['lodash@4.17.21']),
  workspaceRoot: same(['lodash@4.17.0', 'ms@2.0.0']),
  alias: same(['h3-nightly@1.5.0', 'lodash@4.17.21']),
  ownLockUnreadableGoesToChain: same(['lodash@4.17.21']),
  staleMemberLockInWorkspace: same(['lodash@4.17.0']),
  sameNameInDepsAndDevDepsNoLock: same(['lodash@4.17.0']),
  coveringRootLockResolvesMember: same(['lodash@4.17.21']),
  coveringRootWithoutLockGoesToChain: same(['lodash@4.17.0']),
  workspaceDoesNotCoverMember: same(['lodash@4.17.0']),
  nonMemberNestedInsideMember: same(['lodash@4.17.0']),
  nestedWorkspaceRootStaleMemberLock: same(['lodash@4.17.0']),
  negatedWorkspaceMember: same(['lodash@4.17.0']),
  orphanAncestorLockNotUsed: same(['lodash@4.17.0']),
  workspaceRootLockUnreadable: same(['lodash@4.17.21']),
  memberWithoutOwnLockHoistedRoot: same(['lodash@4.17.21']),
  doublestarObjectFormWorkspaces: same(['lodash@4.17.0']),
  twoNestedCoveringRootsNearestWins: same(['lodash@4.17.0']),
  nearestCoveringRootWithoutLockStops: same(['lodash@4.17.0']),
  unevaluableWorkspacePatternGoesToChain: same(['lodash@4.17.0']),
  dotDirNotAWorkspaceMember: same(['lodash@4.17.0']),
  yarnWorkspaceRootStaleMemberPkgLock: same(['lodash@4.17.0']),
  rootYarnLockAndSubPkgLock: same(['lodash@4.17.0']),
  yarnLockInAncestorDirWithoutManifest: same(['lodash@4.17.0']),
  yarnLockInSiblingDirDoesNotVeto: same(['left@1.0.0', 'lodash@4.17.0']),
  nonSemverSpecInOneManifest: same(['lodash@4.17.21']),
  blindSameDirPkgLockPlusYarnLock: same(['lodash@4.17.0']),
  blindSubdirPkgLockPlusYarnLock: same(['lodash@4.17.0']),
  blindAncestorYarnLockVetoes: same(['lodash@4.17.0']),
  blindNoYarnLockPerManifest: same(['lodash@4.17.0']),
  nonMemberNestedUnderMemberLock: same(['lodash@4.17.0']),
  nestedWorkspaceRootMemberStaleLock: same(['lodash@4.17.0']),
  rootManifestUnreadableMemberStaleOwnLock: same(['lodash@4.17.0']),
  negationCancelledByLaterPositive: same(['lodash@4.17.0']),
  negationThenExactReinclude: same(['lodash@4.17.0']),
  pnpmLockPlusTwoStalePkgLocks: same(['lodash@4.17.0']),
  blindYarnLockReadFails: same(['lodash@4.17.21']),
  blindYarnLockReadFailsWithConflict: same(['lodash@4.17.0']),
  observedYarnLockReadFails: same(['lodash@4.17.0']),
  workspaceRootNestedInOuterRoot: same(['lodash@4.17.0']),
  rootLockLacksDepMemberLockHas: same(['lodash@4.17.21']),
  nestedLinkWithoutVersion: same(['lodash@4.17.21']),
  dotSlashWorkspacePattern: same(['lodash@4.17.0']),
  rootV1LockWorkspaceMemberV3: same(['lodash@4.17.0']),
  workspacesObjectNohoistOnly: same(['lodash@4.17.0']),
  bunLockPlusTwoStalePkgLocks: same(['lodash@4.17.0']),
  negTruncatedTree: same(['vite@7.3.5']),
  negManifestListCapped: same(['vite@7.3.5']),
  negYarnLockElsewhere: same(['vite@7.3.5']),
  negPnpmLockElsewhere: same(['vite@7.3.5']),
  negBunLockElsewhere: same(['vite@7.3.5']),
  negBunLockbElsewhere: same(['vite@7.3.5']),
  negShrinkwrapElsewhere: same(['vite@7.3.5']),
  negWorkspacesKeyInAncestor: same(['vite@7.3.5']),
  negAncestorManifestReadError: same(['vite@7.3.5']),
  negAncestorManifestUnparsable: same(['vite@7.3.5']),
  craftedWorkspacesPattern: same(['vite@7.3.5']),

  // ---- narrow shape: head = base - dropped + added ----
  viteGoal: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'frontend installs 7.3.7, backend 8.3.5; the baseline floor 7.3.5 is installed in neither',
  }),
  v1SubprojectPlusV3Subproject: narrow({
    base: ['lodash@4.17.0'],
    dropped: [],
    added: ['lodash@4.17.21'],
    why: 'a/ has a v1 lockfile (not narrow): baseline floor stays; b/ is narrow: 4.17.21 added',
  }),
  nolockSubprojectPlusTwoLocked: narrow({
    base: ['lodash@4.17.0'],
    dropped: [],
    added: ['lodash@4.17.20', 'lodash@4.17.21'],
    why: 'c/ has no lockfile (not narrow): baseline floor stays; a/ and b/ narrow versions added',
  }),
  transitiveNestedCopy: narrow({
    base: ['foo@1.0.0', 'glob@7.0.0'],
    dropped: ['glob@7.0.0'],
    added: ['glob@7.2.3'],
    why: 'single project; glob installed at 7.2.3 (top level) and 7.1.0 (nested under foo); floor 7.0.0 installed nowhere; the nested copy is a transitive install and is queried neither before nor after',
  }),
  depAbsentFromOwnLockButOtherManifestResolves: narrow({
    base: ['lodash@4.0.0'],
    dropped: [],
    added: ['lodash@4.17.20', 'lodash@4.17.21'],
    why: 'b/ lockfile lacks lodash (not narrow): baseline floor stays; a/ and c/ narrow versions added',
  }),
  v1RootLockAndV3Sub: narrow({
    base: ['lodash@4.17.0'],
    dropped: [],
    added: ['lodash@4.17.21'],
    why: 'root has a v1 lockfile (not narrow): baseline floor stays; sub/ is narrow: 4.17.21 added',
  }),
  aliasAndDirectTwoVersions: narrow({
    base: ['lodash@4.17.0'],
    dropped: [],
    added: ['lodash@4.17.21'],
    why: 'a/ declares lodash through an npm: alias (not narrow): baseline floor stays; b/ narrow version added',
  }),
  devDependencyResolvesAgainstOwnLock: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'devDependencies take part like dependencies; floor 7.3.5 installed nowhere',
  }),
  scopedDepAndScopedAlias: narrow({
    base: ['@babel/core@7.0.0'],
    dropped: [],
    added: ['@babel/core@7.20.0'],
    why: 'the alias declaration of @babel/core is not narrow: baseline floor stays; the direct declaration adds the installed 7.20.0',
  }),
  rootProjectPlusSubProject: narrow({
    base: ['lodash@4.17.0'],
    dropped: ['lodash@4.17.0'],
    added: ['lodash@4.17.15', 'lodash@4.17.21'],
    why: 'root and x/ are separate projects; floor 4.17.0 installed nowhere',
  }),
  viteTwoProjects: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'same shape as viteGoal',
  }),
  viteCounterCheckFloorInstalled: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend installs exactly the floor 7.3.5, so the baseline entry stays; backend 8.3.5 is added',
  }),
  noRootBackendVitePlusFrontendVite: narrow({
    base: ['express@5.1.0', 'react@19.1.0', 'vite@7.3.5', 'vitest@3.2.4'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7'],
    why: 'no root package.json; backend has vite only transitively and does not declare it, so only frontend (7.3.7) is narrow for vite; floor 7.3.5 installed nowhere',
  }),
  sixOwnLockProjects: narrow({
    base: ['lodash@4.17.21', 'vite@5.4.0'],
    dropped: ['vite@5.4.0'],
    added: ['vite@5.4.11', 'vite@6.3.0', 'vite@7.3.7', 'vite@8.3.5', 'vite@8.3.6'],
    why: 'six projects, vite installed at five versions; floor 5.4.0 (lowest range) installed nowhere; lodash resolves identically everywhere',
  }),
  scopedPackageTwoProjects: narrow({
    base: ['@babel/core@7.0.0'],
    dropped: ['@babel/core@7.0.0'],
    added: ['@babel/core@7.20.0', '@babel/core@7.26.0'],
    why: 'scoped name; floor 7.0.0 installed nowhere',
  }),
  viteTwoProjectsLockfileV2: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'lockfileVersion 2 is read like 3; floor 7.3.5 installed nowhere',
  }),
  rootProjectAndSubProjectNoWorkspaces: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'root and tools/docs are separate projects (no workspaces key); floor 7.3.5 installed nowhere',
  }),
  viteOneProjectWithoutLockfile: narrow({
    base: ['vite@6.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'scripts/ declares vite ^6.0.0 without a lockfile, so it is not narrow: the baseline floor 6.0.0 stays; the two narrow versions are added',
  }),
  negWorkspacesKeyInSelf: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend has a workspaces key (not narrow): baseline floor stays; standalone backend adds 8.3.5',
  }),
  negUnrelatedManifestReadError: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'tools/package.json cannot be read, so it might declare vite: baseline floor stays; both narrow versions added',
  }),
  negDeclarerWithoutOwnLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5', 'vite@8.3.6'],
    why: 'frontend has no lockfile of its own (not narrow): baseline stays; backend and ops add their versions',
  }),
  negDeclarerLockUnparsable: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5', 'vite@8.3.6'],
    why: 'frontend lockfile is not valid JSON (not narrow): baseline stays; backend and ops add their versions',
  }),
  negDeclarerLockReadError: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5', 'vite@8.3.6'],
    why: 'frontend lockfile cannot be read (not narrow): baseline stays; backend and ops add their versions',
  }),
  negDeclarerLockV1: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend lockfile is v1 (not narrow): baseline stays; backend adds 8.3.5',
  }),
  negDeclarerLockOnlyNestedKey: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend lockfile has vite only nested (no top-level key): baseline stays; backend adds 8.3.5',
  }),
  negDeclarerLockVersionWithoutDigit: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5', 'vite@8.3.6'],
    why: 'frontend lockfile version has no digit (not narrow): baseline stays; backend and ops add their versions',
  }),
  negDeclarationIsAlias: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend declares vite through an alias: baseline stays; backend adds 8.3.5',
  }),
  negDeclarationNotAPlainRange: narrow({
    base: ['vite@8.3.0'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend declares a git spec: baseline stays; backend adds 8.3.5',
  }),
  negLockVersionOutsideDeclaredRange: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend lockfile 7.0.1 does not satisfy ^7.3.5: baseline stays; backend adds 8.3.5',
  }),
  negBaseVersionNestedInOtherLock: narrow({
    base: ['vite@7.3.5', 'vitest@3.2.4'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: '7.3.5 is installed as a nested copy in backend/ lockfile: baseline stays; both narrow versions added',
  }),
  negBaseVersionAliasedInOtherLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: '7.3.5 is installed under an alias key in backend/ lockfile: baseline stays; both narrow versions added',
  }),
  negBaseVersionInOtherV1Lock: narrow({
    base: ['vite@7.3.5', 'vitest@0.34.6'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'legacy/ has a v1 lockfile (it installs 7.3.5 nested, and a v1 lockfile proves nothing anyway): baseline stays; both narrow versions added',
  }),
  negOtherLockReadError: narrow({
    base: ['left@1.0.0', 'vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'legacy/ lockfile cannot be read, so it might install 7.3.5: baseline stays; both narrow versions added',
  }),
  negOtherLockUnparsable: narrow({
    base: ['left@1.0.0', 'vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'legacy/ lockfile is not valid JSON: baseline stays; both narrow versions added',
  }),

  // ---- projects that name the package in a field the baseline does not query,
  // or that have no lockfile of their own ----
  negOptionalExactNoLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ has no lockfile and an optional dependency on vite 7.3.5, which it can install: baseline stays; the two narrow versions are added',
  }),
  negPeerExactNoLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ has no lockfile and a peer dependency on vite 7.3.5: baseline stays; the two narrow versions are added',
  }),
  negBundledNoLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ has no lockfile and bundles vite: baseline stays; the two narrow versions are added',
  }),
  negOptionalExactWithLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ has a lockfile that installs vite 7.3.5 (optional dependency): baseline stays; it adds nothing itself',
  }),
  negOverridesNoLock: narrow({
    base: ['vite@7.3.5', 'vitest@3.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ has no lockfile and pins vite 7.3.5 through overrides: baseline stays; the two narrow versions are added',
  }),
  negUnrelatedProjectNoLock: narrow({
    base: ['left@1.0.0', 'vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'tools/ does not mention vite but has no lockfile, so it could install anything: baseline stays; the two narrow versions are added',
  }),
  negRootManifestNoLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a root package.json without a lockfile: baseline stays; the two narrow versions are added',
  }),
  optionalSatisfiedWithLock: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ declares vite optionally (>=7 <9) and its own lockfile installs 7.3.7; it blocks nothing, and the 7.3.7 it installs is also added by frontend/; floor 7.3.5 installed nowhere',
  }),
  peerSatisfiedWithLock: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'plugin/ has a peer range ^7.0.0 || ^8.0.0 and its own lockfile installs 8.3.5; it blocks nothing, and the 8.3.5 it installs is also added by backend/; floor 7.3.5 installed nowhere',
  }),
  vendoredManifestNotRead: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a manifest under node_modules is never read, so it is not a project without a lockfile; floor 7.3.5 installed in no lockfile the scan reads',
  }),
  // ---- an extra project whose lockfile or manifest holds something the drop proof
  // cannot read as "installs nothing": the baseline floor stays ----
  negV1GitVersionTransitive: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile v1 has a nested vite at a git URL version (not semver): what it installs is unknown, so vite is never provably uninstalled',
  }),
  negV1TarballVersionTransitive: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile v1 has a nested vite at a tarball URL version: unknown',
  }),
  negV1FileVersionTransitive: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile v1 has a nested vite at a file: version: unknown',
  }),
  negV3EntryWithoutVersion: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile v3 has a nested vite entry without a version: unknown',
  }),
  negV3EntryNotAnObject: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile v3 has a nested vite entry that is a string: unknown',
  }),
  negUnknownLockfileVersion: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile has lockfileVersion 4: shape unknown, nothing provable',
  }),
  negLockfileVersion3WithoutPackages: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile is version 3 without a packages map: nothing provable',
  }),
  negStaleLockMissingDeclaredDep: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ declares x but its lockfile lists nothing: npm installs x fresh, so the project is not locked',
  }),
  negStaleLockOneDepAddedLater: narrow({
    base: ['ms@2.1.3', 'vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lists ms but not x, added later: not locked (ms is already a baseline entry, so it is not an addition)',
  }),
  negStaleLockRangeUnsatisfied: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile has x 1.0.0 but the manifest asks ^2.0.0: the lockfile is stale, not locked',
  }),
  negStaleLockMissingDevDep: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile lacks a devDependency: not locked',
  }),
  negStaleLockMissingOptionalDep: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile lacks an optionalDependency: not locked',
  }),
  negStaleV1LockMissingDeclaredDep: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile v1 lacks a declared dependency: not locked',
  }),
  extraProjectCompleteLock: narrow({
    base: ['vite@7.3.5', 'x@1.2.0', 'y@1.0.0'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile lists x (in range) and the git-spec y: the project is locked; floor 7.3.5 installed nowhere (x@1.2.0 and y@1.0.0 are baseline entries that stay)',
  }),
  negNpmrcInProject: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'frontend/ has an .npmrc (package-lock=false is possible): no drops',
  }),
  negNpmrcAtRoot: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a root .npmrc: no drops',
  }),
  negPackageManagerYarnField: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'frontend/package.json has a packageManager field: no drops',
  }),
  negPackageManagerInUnrelatedManifest: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'tools/package.json has a packageManager field and no vite: still no drops',
  }),
  vendoredNpmrcNotRead: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'an .npmrc under node_modules is not read, like the manifests there; floor 7.3.5 installed in no lockfile the scan reads',
  }),

  // ---- peer dependencies, overrides, loose lockfile validity, edges, link and
  // renamed entries, other package managers' files ----
  negPeerUnlistedTransitive: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ has a peer dependency its lockfile does not list; npm installs peers, so the project is not locked',
  }),
  negPeerUnlistedTransitiveV1: narrow({
    base: ['ms@2.1.3', 'vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ has a lockfileVersion 1 lockfile that lists its dependency ms but not its peer dependency',
  }),
  negPeerOutOfRange: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile lists the peer at 1.0.0 but the manifest asks for ^2.0.0: stale lockfile',
  }),
  peerListedInRange: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5', 'x@1.4.0'],
    why: 'positive control: extra/ lists its peer in range, so it is locked; the peer x installs at 1.4.0 under npm ci and is queried; floor 7.3.5 installed nowhere',
  }),
  optionalPeerNotListed: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'positive control: a peer marked optional in peerDependenciesMeta need not be listed; floor 7.3.5 installed nowhere',
  }),
  negOverridesStaleLock: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ overrides vite to 7.3.5 but its lockfile holds vite 7.3.6: the lockfile does not reflect the override',
  }),
  overridesReflectedInLock: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'positive control: extra/ overrides vite to 7.3.6 and its lockfile holds exactly that; floor 7.3.5 installed nowhere',
  }),
  negOverridesNestedObject: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ has an override written as a nested object: not a plain string spec, so its lockfile cannot be taken to reflect it',
  }),
  negOverridesDollarReference: narrow({
    base: ['ms@2.1.3', 'vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ has a $ reference override',
  }),
  negPrereleaseStaleLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend lockfile holds 7.4.0-beta.1, which npm does not accept for ^7.3.5 (no includePrerelease): not narrow, floor stays; backend adds 8.3.5',
  }),
  negLockEdgeWithoutEntry: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile has an entry that depends on vite while the lockfile has no vite entry: npm install resolves the edge from the registry, so the lockfile is unusable',
  }),
  negPeerEdgeMissingExact: narrow({
    base: ['plug@1.0.0', 'vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile was written with --legacy-peer-deps: plug peer-depends on vite 7.3.5 and the lockfile has no vite entry, so npm install would add it; the lockfile is unusable',
  }),
  negDepEdgeToUnrelatedNameWithoutEntry: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ lockfile has an entry with an edge to a name without an entry: the whole lockfile is unusable, whatever the name',
  }),
  negOptionalDepEdgeWithoutEntry: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'the same for an optionalDependencies edge',
  }),
  negV1RequiresMissing: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'extra/ has a lockfileVersion 1 lockfile whose entry requires vite: v1 proves nothing, npm re-resolves from the registry',
  }),
  negV1LockOfUnrelatedProject: narrow({
    base: ['vite@7.3.5', 'x@1.0.0'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a lockfileVersion 1 lockfile anywhere in the tree makes every name not provable',
  }),
  optionalPeerEdgeWithoutEntry: narrow({
    base: ['plug@1.0.0', 'vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'the peer on vite is marked optional in the entry, so npm does not install it and the lockfile needs no vite entry; floor 7.3.5 installed in no lockfile',
  }),
  bundledNameEdgeWithoutEntry: narrow({
    base: ['vite@7.3.5', 'w@1.0.0'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'w lists its edges in bundleDependencies (npm takes them from the tarball), so the missing entries do not make the lockfile unusable; floor 7.3.5 installed in no lockfile',
  }),
  overrideAcrossEdgeRange: narrow({
    base: ['eslint@9.0.0', 'vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'the lockfile holds minimatch 10.2.5 for an edge that asks ^3.1.5, because the manifest overrides it; the entry exists, so the lockfile stays usable and the floor 7.3.5 is installed in no lockfile',
  }),
  negLinkEntryWithVersion: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@8.3.5'],
    why: 'frontend lockfile has vite as a link entry that carries a version: not narrow, adds nothing; backend adds 8.3.5',
  }),
  negEntryRenamedByNameField: same(['vite@8.3.5']),
  negDenoLock: same(['vite@7.3.5']),
  negPnpmWorkspaceWithoutPnpmLock: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a pnpm-workspace.yaml at the root: no drops',
  }),
  negYarnrcYmlAtRoot: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a .yarnrc.yml at the root: no drops',
  }),
  negPnpmfileInProject: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'a .pnpmfile.cjs in backend/: no drops',
  }),
  negDevEnginesPackageManager: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'frontend/package.json pins a package manager through devEngines: no drops',
  }),
  // ---- peer and optional declarations (vite fixture `viteMidFiles`: a/ installs
  // 7.3.7 through a dependency, b/ declares vite another way and installs
  // 7.3.6). Before the peer/optional additions, only a/'s version was queried
  // and the floor was dropped, so b/'s 7.3.6 was never queried. ----
  midPeerDeclarer: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.6', 'vite@7.3.7'],
    why: 'b/ has vite as a non-optional peer and installs 7.3.6 under npm ci: queried like a dependency; floor 7.3.5 installed nowhere',
  }),
  midOptionalDeclarer: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.6', 'vite@7.3.7'],
    why: 'b/ has vite in optionalDependencies and installs 7.3.6: queried like a dependency; floor 7.3.5 installed nowhere',
  }),
  midBundledDeclarer: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7'],
    why: 'a bundled name carries no range and never adds: only a/ adds 7.3.7, 7.3.6 is not queried; floor 7.3.5 installed nowhere',
  }),
  midOptionalPeerListed: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.6', 'vite@7.3.7'],
    why: 'b/ has vite as an optional peer and its lockfile has the top-level entry 7.3.6, so npm installs it: queried; floor 7.3.5 installed nowhere',
  }),
  midOptionalPeerUnlisted: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'b/ has vite as an optional peer its lockfile does not list: not installed, nothing to add, and it cannot be proven narrow, so the floor stays',
  }),
  midPeerOutOfRange: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7'],
    why: 'b/ lockfile installs 7.1.0 outside the declared peer range ^7.3.6: stale, not narrow: nothing added, floor stays',
  }),
  midOptionalOutOfRange: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7'],
    why: 'the same for an optionalDependencies declaration: nothing added, floor stays',
  }),
  midPeerAlias: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7'],
    why: 'b/ declares the peer through an npm: alias: never narrow, nothing added, floor stays',
  }),
  midOptionalAlias: narrow({
    base: ['vite@7.3.5'],
    dropped: [],
    added: ['vite@7.3.7'],
    why: 'the same for an optionalDependencies alias: nothing added, floor stays',
  }),
  midPeerAndDevDeclarer: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.6', 'vite@7.3.7'],
    why: 'b/ declares vite as peer and dev dependency (the usual plugin shape): 7.3.6 added once; floor 7.3.5 installed nowhere',
  }),
  midPeerOnLocalPackage: narrow({
    base: ['vite@7.3.7'],
    dropped: [],
    added: [],
    why: 'b/ has a peer on the repository\'s own package a, which is never queried (local name); nothing changes',
  }),
  midPeerForeignLockfile: same(['vite@7.3.5']),
  midPeerInWorkspaceMember: same(['vite@7.3.5']),
  vendoredPackageManagerConfigNotRead: narrow({
    base: ['vite@7.3.5'],
    dropped: ['vite@7.3.5'],
    added: ['vite@7.3.7', 'vite@8.3.5'],
    why: 'package manager config files under node_modules and dist are not read; floor 7.3.5 installed in no lockfile the scan reads',
  }),
};

describe('narrow npm lockfile override: end-to-end OSV query scenarios', () => {
  it('has an expectation for every scenario and no stale ones', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}`, async () => {
      const expected = EXPECTED[name];
      const { queries, degraded } = await runScan(fetchOsvAdvisories, scenario);

      const head = [...expected.base.filter((q) => !expected.dropped.includes(q)), ...expected.added].sort();
      expect(queries).toEqual(head);

      // No base entry is lost unless it is a documented drop.
      expect(expected.base.filter((q) => !queries.includes(q)).sort()).toEqual([...expected.dropped].sort());
      // A drop always comes with a reason.
      if (expected.dropped.length > 0) expect(expected.why).toBeTruthy();
      // A failed read stays reported as degraded.
      expect(degraded !== null).toBe((scenario.fail ?? []).length > 0);
    });
  }
});
