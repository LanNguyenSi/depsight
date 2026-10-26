/**
 * End-to-end tests for the narrow npm lockfile override, one per behaviour the
 * override promises and one per condition of its drop rule. Everything runs
 * through the real pipeline on synthetic repositories (see
 * tests/unit/helpers/npm-scenarios.ts for the files); only GitHub and `fetch`
 * are mocked.
 *
 * Drop rule conditions (a baseline entry is removed only if all hold):
 *   - the tree walk was complete
 *   - no other package manager's lockfile exists anywhere
 *   - no `.npmrc` exists anywhere and no manifest has a `packageManager` field
 *   - every manifest the scan reads is locked: its own lockfile has a known
 *     shape and lists every dependency, devDependency and optionalDependency in
 *     range
 *   - every manifest declaring the name is narrow for it
 *   - the baseline version is installed by no fetched lockfile, anywhere, and
 *     every lockfile entry that names a package carries a semver version
 *
 * In the negative tests the baseline floor `vite@7.3.5` must stay in the
 * result; where the violation leaves other manifests narrow, their installed
 * versions are added next to it (the exact expected set is spelled out).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { detectEcosystem } from '@/lib/manifest-discovery';
import { loadRepo, pkg, runScan, v1, v3 } from './helpers/npm-repo-fixture';
import { SCENARIOS } from './helpers/npm-scenarios';

const scan = async (name: string) => (await runScan(fetchOsvAdvisories, SCENARIOS[name])).queries;

describe('regression: a name installed at different versions in separate projects', () => {
  it('queries exactly the installed versions, not the uninstalled floor (vite 7.3.7 / 8.3.5)', async () => {
    expect(await scan('viteTwoProjects')).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('counter-check: when the lockfile installs the floor, the floor is queried', async () => {
    expect(await scan('viteCounterCheckFloorInstalled')).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });

  it('devDependencies take part like dependencies', async () => {
    expect(await scan('devDependencyResolvesAgainstOwnLock')).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('no root package.json, backend has vite only transitively: only the declared vite is queried, at its installed version', async () => {
    expect(await scan('noRootBackendVitePlusFrontendVite')).toEqual([
      'express@5.1.0',
      'react@19.1.0',
      'vite@7.3.7',
      'vitest@3.2.4',
    ]);
  });

  it('six projects with their own lockfiles: one query per installed version, no uninstalled floor', async () => {
    expect(await scan('sixOwnLockProjects')).toEqual([
      'lodash@4.17.21',
      'vite@5.4.11',
      'vite@6.3.0',
      'vite@7.3.7',
      'vite@8.3.5',
      'vite@8.3.6',
    ]);
  });

  it('a root project and a standalone sub-project (no workspaces key anywhere)', async () => {
    expect(await scan('rootProjectAndSubProjectNoWorkspaces')).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('one declaring project without a lockfile keeps the baseline floor and still adds the others', async () => {
    expect(await scan('viteOneProjectWithoutLockfile')).toEqual(['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('drop rule: tree walk complete', () => {
  it('truncated tree: result equals the baseline', async () => {
    expect(await scan('negTruncatedTree')).toEqual(['vite@7.3.5']);
  });

  it('manifest list capped at its limit: result equals the baseline', async () => {
    expect(await scan('negManifestListCapped')).toEqual(['vite@7.3.5']);
  });

  it('a manifest list exactly at its limit is complete: the narrow override applies', async () => {
    const { queries } = await runScan(fetchOsvAdvisories, {
      ...SCENARIOS.viteTwoProjects,
      extraManifests: 98,
      lockedFillers: true,
    });
    expect(queries).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('a complete manifest list with project manifests that have no lockfile adds the installed versions but keeps the baseline floor', async () => {
    const { queries } = await runScan(fetchOsvAdvisories, { ...SCENARIOS.viteTwoProjects, extraManifests: 98 });
    expect(queries).toEqual(['vite@7.3.5', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('detectEcosystem records the cap and the foreign lockfiles, and nothing when the walk is incomplete', async () => {
    loadRepo({ ...SCENARIOS.negYarnLockElsewhere, extraManifests: 100 });
    const capped = await detectEcosystem('t', 'o', 'r', 'main');
    expect(capped.observedTreeFacts).toEqual({ foreignLockfilePaths: ['tools/yarn.lock'], manifestsCapped: true, npmrcPaths: [], packageManagerConfigPaths: [] });
    expect(capped.manifestPaths).toHaveLength(100);

    loadRepo(SCENARIOS.viteTwoProjects);
    const whole = await detectEcosystem('t', 'o', 'r', 'main');
    expect(whole.observedTreeFacts).toEqual({ foreignLockfilePaths: [], manifestsCapped: false, npmrcPaths: [], packageManagerConfigPaths: [] });

    loadRepo(SCENARIOS.negNpmrcInProject);
    const withNpmrc = await detectEcosystem('t', 'o', 'r', 'main');
    expect(withNpmrc.observedTreeFacts?.npmrcPaths).toEqual(['frontend/.npmrc']);
    loadRepo(SCENARIOS.vendoredNpmrcNotRead);
    expect((await detectEcosystem('t', 'o', 'r', 'main')).observedTreeFacts?.npmrcPaths).toEqual([]);

    loadRepo(SCENARIOS.negDenoLock);
    expect((await detectEcosystem('t', 'o', 'r', 'main')).observedTreeFacts?.foreignLockfilePaths).toEqual(['frontend/deno.lock']);

    loadRepo(SCENARIOS.negPnpmfileInProject);
    expect((await detectEcosystem('t', 'o', 'r', 'main')).observedTreeFacts?.packageManagerConfigPaths).toEqual(['backend/.pnpmfile.cjs']);
    loadRepo(SCENARIOS.vendoredPackageManagerConfigNotRead);
    expect((await detectEcosystem('t', 'o', 'r', 'main')).observedTreeFacts?.packageManagerConfigPaths).toEqual([]);

    loadRepo(SCENARIOS.negTruncatedTree);
    const truncated = await detectEcosystem('t', 'o', 'r', 'main');
    expect(truncated.observedLockfilePaths).toBeNull();
    expect(truncated.observedTreeFacts).toBeNull();

    // Exactly 100 manifests fit the cap (nothing is cut); 101 do not.
    loadRepo({ ...SCENARIOS.viteTwoProjects, extraManifests: 98 });
    expect((await detectEcosystem('t', 'o', 'r', 'main')).observedTreeFacts?.manifestsCapped).toBe(false);
    loadRepo({ ...SCENARIOS.viteTwoProjects, extraManifests: 99 });
    expect((await detectEcosystem('t', 'o', 'r', 'main')).observedTreeFacts?.manifestsCapped).toBe(true);

    // A complete walk with zero manifests falls back to the root probe: also incomplete.
    loadRepo({ files: { 'README.md': '# nothing' } });
    const empty = await detectEcosystem('t', 'o', 'r', 'main');
    expect(empty.observedTreeFacts).toBeNull();
  });
});

describe('drop rule: no other package manager lockfile anywhere', () => {
  for (const name of [
    'negYarnLockElsewhere',
    'negPnpmLockElsewhere',
    'negBunLockElsewhere',
    'negBunLockbElsewhere',
    'negShrinkwrapElsewhere',
  ]) {
    it(`${name}: result equals the baseline`, async () => {
      expect(await scan(name)).toEqual(['vite@7.3.5']);
    });
  }
});

describe('drop rule: no .npmrc and no packageManager field', () => {
  for (const name of [
    'negNpmrcInProject',
    'negNpmrcAtRoot',
    'negPackageManagerYarnField',
    'negPackageManagerInUnrelatedManifest',
  ]) {
    it(`${name}: the baseline floor stays and the narrow versions are still added`, async () => {
      expect(await scan(name)).toEqual(['vite@7.3.5', 'vite@7.3.7', 'vite@8.3.5']);
    });
  }

  it('an .npmrc in a vendored directory is not read: the floor is still dropped', async () => {
    expect(await scan('vendoredNpmrcNotRead')).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('drop rule: every project is locked and every lockfile entry is readable', () => {
  for (const name of [
    'negV1GitVersionTransitive',
    'negV1TarballVersionTransitive',
    'negV1FileVersionTransitive',
    'negV3EntryWithoutVersion',
    'negV3EntryNotAnObject',
    'negUnknownLockfileVersion',
    'negLockfileVersion3WithoutPackages',
    'negStaleLockMissingDeclaredDep',
    'negStaleLockOneDepAddedLater',
    'negStaleLockRangeUnsatisfied',
    'negStaleLockMissingDevDep',
    'negStaleLockMissingOptionalDep',
    'negStaleV1LockMissingDeclaredDep',
  ]) {
    it(`${name}: the baseline floor stays`, async () => {
      expect(await scan(name)).toContain('vite@7.3.5');
    });
  }

  it('a project whose lockfile lists everything it declares does not block the drop', async () => {
    expect(await scan('extraProjectCompleteLock')).toEqual(['vite@7.3.7', 'vite@8.3.5', 'x@1.2.0', 'y@1.0.0']);
  });
});

describe('drop rule: every declaring manifest is narrow for the name', () => {
  it('workspaces key in an ancestor package.json (even an empty array): result equals the baseline', async () => {
    expect(await scan('negWorkspacesKeyInAncestor')).toEqual(['vite@7.3.5']);
  });

  it('workspaces key in the declaring manifest itself: floor stays, the standalone project adds its version', async () => {
    expect(await scan('negWorkspacesKeyInSelf')).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });

  it('ancestor package.json unreadable (500): result equals the baseline', async () => {
    expect(await scan('negAncestorManifestReadError')).toEqual(['vite@7.3.5']);
  });

  it('ancestor package.json not valid JSON: result equals the baseline', async () => {
    expect(await scan('negAncestorManifestUnparsable')).toEqual(['vite@7.3.5']);
  });

  it('an unrelated manifest unreadable (500): floor stays, narrow versions are added', async () => {
    expect(await scan('negUnrelatedManifestReadError')).toEqual(['vite@7.3.5', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('declaring manifest without a lockfile of its own', async () => {
    expect(await scan('negDeclarerWithoutOwnLock')).toEqual(['vite@7.3.5', 'vite@8.3.5', 'vite@8.3.6']);
  });

  it('declaring manifest with an unparsable lockfile', async () => {
    expect(await scan('negDeclarerLockUnparsable')).toEqual(['vite@7.3.5', 'vite@8.3.5', 'vite@8.3.6']);
  });

  it('declaring manifest whose lockfile cannot be read (500)', async () => {
    expect(await scan('negDeclarerLockReadError')).toEqual(['vite@7.3.5', 'vite@8.3.5', 'vite@8.3.6']);
  });

  it('declaring manifest with a lockfileVersion 1 lockfile', async () => {
    expect(await scan('negDeclarerLockV1')).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });

  it('declaring manifest whose lockfile lists the name only nested', async () => {
    expect(await scan('negDeclarerLockOnlyNestedKey')).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });

  it('declaring manifest whose lockfile version has no digit', async () => {
    expect(await scan('negDeclarerLockVersionWithoutDigit')).toEqual(['vite@7.3.5', 'vite@8.3.5', 'vite@8.3.6']);
  });

  it('declaration through an npm: alias', async () => {
    expect(await scan('negDeclarationIsAlias')).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });

  it('declaration that is not a plain semver range (git spec)', async () => {
    // The baseline here is 8.3.0, the floor of the only semver range; the git spec is not narrow
    // and no range to compare, so every lockfile version of the name (7.3.7 too) is queried.
    expect(await scan('negDeclarationNotAPlainRange')).toEqual(['vite@7.3.7', 'vite@8.3.0', 'vite@8.3.5']);
  });

  it('installed version outside the declared range (stale lockfile)', async () => {
    expect(await scan('negLockVersionOutsideDeclaredRange')).toEqual(['vite@7.3.5', 'vite@8.3.5']);
  });
});

describe('drop rule: the baseline version is installed nowhere', () => {
  it('installed as a nested copy in another lockfile', async () => {
    expect(await scan('negBaseVersionNestedInOtherLock')).toEqual([
      'vite@7.3.5',
      'vite@7.3.7',
      'vite@8.3.5',
      'vitest@3.2.4',
    ]);
  });

  it('installed under an alias key in another lockfile', async () => {
    expect(await scan('negBaseVersionAliasedInOtherLock')).toEqual(['vite@7.3.5', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('installed nested in a lockfileVersion 1 lockfile of a project that does not declare the name', async () => {
    expect(await scan('negBaseVersionInOtherV1Lock')).toEqual([
      'vite@7.3.5',
      'vite@7.3.7',
      'vite@8.3.5',
      'vitest@0.34.6',
    ]);
  });

  it('a lockfile elsewhere cannot be read (500)', async () => {
    expect(await scan('negOtherLockReadError')).toEqual(['left@1.0.0', 'vite@7.3.5', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('a lockfile elsewhere is not valid JSON', async () => {
    expect(await scan('negOtherLockUnparsable')).toEqual(['left@1.0.0', 'vite@7.3.5', 'vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('workspaces are only tested for presence', () => {
  // A pattern that made an earlier glob matcher run for seconds: nothing is
  // built from it any more, so this must finish well inside the timeout.
  it('a crafted workspaces pattern is not evaluated', { timeout: 2000 }, async () => {
    expect(await scan('craftedWorkspacesPattern')).toEqual(['vite@7.3.5']);
  });

  it('a very long workspaces list is not evaluated either', { timeout: 2000 }, async () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `packages/${'*'.repeat(1 + (i % 7))}/a${i}`);
    const { queries } = await runScan(fetchOsvAdvisories, {
      files: {
        'package.json': pkg({ name: 'root', workspaces: many }),
        'package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
        'packages/m/package.json': pkg({ name: 'm', dependencies: { vite: '^7.3.5' } }),
        'packages/m/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      },
    });
    expect(queries).toEqual(['vite@7.3.5']);
  });
});

describe('npm workspaces and mixed shapes keep the baseline', () => {
  it('a workspace root with a member that has a stale own lockfile', async () => {
    expect(await scan('staleMemberLockInWorkspace')).toEqual(['lodash@4.17.0']);
  });

  it('a workspace member with a v1 root lockfile (npm 6 era)', async () => {
    expect(await scan('rootV1LockWorkspaceMemberV3')).toEqual(['lodash@4.17.0']);
  });

  it('v1 lockfiles at the root are not narrow-resolved', async () => {
    const { queries } = await runScan(fetchOsvAdvisories, {
      files: {
        'package.json': pkg({ dependencies: { lodash: '^4.17.0' } }),
        'package-lock.json': v1({ lodash: '4.17.15' }),
      },
    });
    expect(queries).toEqual(['lodash@4.17.15']);
  });
});
