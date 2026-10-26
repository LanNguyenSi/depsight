/**
 * `collectNpmReportVersions` (lib/cve/osv.ts): the rule that decides, per npm
 * package name, whether the dependency-age report keeps the manifest floor
 * strip or shows a higher version. The narrow resolution (which declarers are
 * proven, which versions their own lockfiles install) is stubbed here, so each
 * branch of the rule is pinned on its own; deps-age-lockfile.test.ts runs the
 * real proof end to end.
 *
 * The rule: `raisedTo` is the lowest version the narrow resolution adds for the
 * name, only when the name has a usable floor, no manifest declares the name
 * outside `dependencies` and `devDependencies`, `dropSafe(name, floor)` holds,
 * the resolution added a version for the name, and that version is not below
 * the floor. In every other case `raisedTo` is null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

const narrowStub = vi.hoisted(() => ({
  additions: [] as Array<{ name: string; version: string }>,
  dropSafe: vi.fn<(name: string, baseVersion: string) => boolean>(() => true),
}));

vi.mock('@/lib/manifest-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifest-discovery')>();
  return {
    ...actual,
    resolveNarrowNpm: () => ({ additions: narrowStub.additions, dropSafe: narrowStub.dropSafe }),
  };
});

import { createGitHubClient } from '@/lib/github';
import { collectNpmReportVersions, fetchOsvAdvisories } from '@/lib/cve/osv';
import { loadRepo, pkg, runScan } from './helpers/npm-repo-fixture';

/** The report rows for one project declaring `vite` (and optionally other packages) with the given specs. */
async function rows(deps: Record<string, string>) {
  loadRepo({ files: {} });
  return collectNpmReportVersions(
    createGitHubClient('t'),
    'o',
    'r',
    ['package.json'],
    { npm: [], yarn: [] },
    null,
    { manifests: [{ name: 'app', dependencies: deps }], manifestFiles: [] },
  );
}

const vite = async (spec: string) => (await rows({ vite: spec })).find((r) => r.name === 'vite')!;

beforeEach(() => {
  narrowStub.additions = [];
  narrowStub.dropSafe.mockReset();
  narrowStub.dropSafe.mockReturnValue(true);
});

describe('collectNpmReportVersions: raisedTo', () => {
  it('the lowest addition of the name when the proof holds', async () => {
    narrowStub.additions = [
      { name: 'vite', version: '8.3.5' },
      { name: 'vite', version: '7.3.9' },
      { name: 'vite', version: '7.3.7' },
    ];
    expect(await vite('^7.3.5')).toEqual({ name: 'vite', strip: '7.3.5', raisedTo: '7.3.7' });
  });

  it('semver order, not string order, and not the first or last addition', async () => {
    narrowStub.additions = [
      { name: 'vite', version: '10.0.0' },
      { name: 'vite', version: '9.1.0' },
      { name: 'vite', version: '9.10.0' },
    ];
    expect((await vite('^9.0.0')).raisedTo).toBe('9.1.0');
  });

  it('additions of other names are ignored', async () => {
    narrowStub.additions = [
      { name: 'left-pad', version: '1.0.0' },
      { name: 'vite', version: '7.3.7' },
    ];
    const result = await rows({ vite: '^7.3.5', 'left-pad': '^0.9.0' });
    expect(result.map((r) => [r.name, r.raisedTo])).toEqual([
      ['vite', '7.3.7'],
      ['left-pad', '1.0.0'],
    ]);
  });

  it('no proof (dropSafe false): null although the resolution added versions', async () => {
    narrowStub.dropSafe.mockReturnValue(false);
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    expect(await vite('^7.3.5')).toEqual({ name: 'vite', strip: '7.3.5', raisedTo: null });
  });

  it('the proof is asked for this name and its floor', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    await vite('~7.3.5');
    expect(narrowStub.dropSafe).toHaveBeenCalledWith('vite', '7.3.5');
  });

  it('proof without an addition for the name: null', async () => {
    narrowStub.additions = [{ name: 'other', version: '1.0.0' }];
    expect(await vite('^7.3.5')).toEqual({ name: 'vite', strip: '7.3.5', raisedTo: null });
  });

  it('proof and no additions at all: null', async () => {
    expect(await vite('^7.3.5')).toEqual({ name: 'vite', strip: '7.3.5', raisedTo: null });
  });

  it('the lowest addition is below the floor: null (the row is never below the floor)', async () => {
    narrowStub.additions = [
      { name: 'vite', version: '5.4.0' },
      { name: 'vite', version: '7.3.7' },
    ];
    expect((await vite('^7.3.5')).raisedTo).toBeNull();
  });

  it('the lowest addition equals the floor: that version', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.3.5' }];
    expect((await vite('^7.3.5')).raisedTo).toBe('7.3.5');
  });

  it('a prerelease floor and a prerelease addition above it', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.3.5-beta.2' }];
    expect(await vite('^7.3.5-beta.1')).toEqual({ name: 'vite', strip: '7.3.5-beta.1', raisedTo: '7.3.5-beta.2' });
  });
});

describe('collectNpmReportVersions: the floor the proof is asked about', () => {
  it('a partial version (`^8`): the strip is "8", the proof is asked about the range minimum 8.0.0', async () => {
    narrowStub.additions = [{ name: 'vite', version: '8.3.5' }];
    expect(await vite('^8')).toEqual({ name: 'vite', strip: '8', raisedTo: '8.3.5' });
    expect(narrowStub.dropSafe).toHaveBeenCalledWith('vite', '8.0.0');
  });

  it('a range whose strip is not a version (`>=7.3.0 <8`): the proof is asked about 7.3.0', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.5.0' }];
    expect(await vite('>=7.3.0 <8')).toEqual({ name: 'vite', strip: '7.3.0 <8', raisedTo: '7.5.0' });
    expect(narrowStub.dropSafe).toHaveBeenCalledWith('vite', '7.3.0');
  });

  it('an exclusive lower bound (`>7.3.5`): the floor is the stripped 7.3.5, not the range minimum 7.3.6', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.4.0' }];
    expect(await vite('>7.3.5')).toEqual({ name: 'vite', strip: '7.3.5', raisedTo: '7.4.0' });
    expect(narrowStub.dropSafe).toHaveBeenCalledWith('vite', '7.3.5');
  });

  it('a spec with no usable floor (`latest`): null, the proof is not asked', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    expect(await vite('latest')).toEqual({ name: 'vite', strip: '', raisedTo: null });
    expect(narrowStub.dropSafe).not.toHaveBeenCalled();
  });

  it('the wildcard (`*`) has no floor either: null, the proof is not asked', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    expect(await vite('*')).toEqual({ name: 'vite', strip: '', raisedTo: null });
    expect(narrowStub.dropSafe).not.toHaveBeenCalled();
  });

  it('a git spec whose digits strip to a non-version (`github:acme/widget2#main`): null, the proof is not asked', async () => {
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    expect((await vite('github:acme/widget2#main')).raisedTo).toBeNull();
    expect(narrowStub.dropSafe).not.toHaveBeenCalled();
  });

  it('one row per name, from the unioned (lowest) spec', async () => {
    loadRepo({ files: {} });
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    const result = await collectNpmReportVersions(
      createGitHubClient('t'),
      'o',
      'r',
      ['a/package.json', 'b/package.json'],
      { npm: [], yarn: [] },
      null,
      {
        manifests: [
          { name: 'a', dependencies: { vite: '^8.3.0' } },
          { name: 'b', devDependencies: { vite: '^7.3.5' } },
        ],
        manifestFiles: [],
      },
    );
    expect(result).toEqual([{ name: 'vite', strip: '7.3.5', raisedTo: '7.3.7' }]);
  });
});

describe('collectNpmReportVersions: a declaration outside dependencies and devDependencies keeps the floor', () => {
  // The proof is stubbed to hold and the resolution adds 7.3.7, so only the
  // declaration check decides. The check reads the manifests as the scan
  // parsed them, so the fields are typed loosely here.
  type LooseManifest = Record<string, unknown>;
  async function viteBeside(other: LooseManifest) {
    loadRepo({ files: {} });
    narrowStub.additions = [{ name: 'vite', version: '7.3.7' }];
    const result = await collectNpmReportVersions(
      createGitHubClient('t'),
      'o',
      'r',
      ['a/package.json', 'b/package.json'],
      { npm: [], yarn: [] },
      null,
      { manifests: [{ name: 'a', dependencies: { vite: '^7.3.5' } }, { name: 'b', ...other }], manifestFiles: [] },
    );
    return result.find((r) => r.name === 'vite')!;
  }
  const floor = { name: 'vite', strip: '7.3.5', raisedTo: null };
  const raised = { name: 'vite', strip: '7.3.5', raisedTo: '7.3.7' };

  it('control: a second `dependencies` declarer: raised', async () => {
    expect(await viteBeside({ dependencies: { vite: '^7.3.6' } })).toEqual(raised);
  });

  it('`peerDependencies`: null although the proof holds and the resolution added 7.3.7', async () => {
    expect(await viteBeside({ peerDependencies: { vite: '^7.3.6' } })).toEqual(floor);
  });

  it('`peerDependencies` marked optional in `peerDependenciesMeta`: null', async () => {
    const other = { peerDependencies: { vite: '^7.3.6' }, peerDependenciesMeta: { vite: { optional: true } } };
    expect(await viteBeside(other)).toEqual(floor);
  });

  it('`optionalDependencies`: null', async () => {
    expect(await viteBeside({ optionalDependencies: { vite: '^7.3.6' } })).toEqual(floor);
  });

  it('`bundleDependencies` and `bundledDependencies` lists naming the package: null', async () => {
    expect(await viteBeside({ bundleDependencies: ['vite'] })).toEqual(floor);
    expect(await viteBeside({ bundledDependencies: ['vite'] })).toEqual(floor);
  });

  it('an `npm:` alias in `peerDependencies` declares its target: null for the target', async () => {
    expect(await viteBeside({ peerDependencies: { v: 'npm:vite@^7.3.6' } })).toEqual(floor);
  });

  it('an `npm:` alias of another package under the key `vite`: not a declaration of vite, raised', async () => {
    expect(await viteBeside({ peerDependencies: { vite: 'npm:other@^1.0.0' } })).toEqual(raised);
  });

  it('a peer declaration of another package: raised', async () => {
    expect(await viteBeside({ peerDependencies: { other: '^1.0.0' } })).toEqual(raised);
  });

  it('a boolean `bundleDependencies` (it bundles the `dependencies`): raised', async () => {
    expect(await viteBeside({ dependencies: { vite: '^7.3.6' }, bundleDependencies: true })).toEqual(raised);
  });

  it('a map or list of another shape (null, a string) is left to the proof: raised here, no throw', async () => {
    expect(await viteBeside({ peerDependencies: null })).toEqual(raised);
    expect(await viteBeside({ optionalDependencies: 'vite' })).toEqual(raised);
    expect(await viteBeside({ bundleDependencies: 'vite' })).toEqual(raised);
  });

  it('a non-string spec under the key `vite` is a declaration of vite by its key: null, no throw', async () => {
    expect(await viteBeside({ peerDependencies: { vite: 7 } })).toEqual(floor);
  });
});

describe('the floor is the same one the CVE scan queries when nothing is resolved', () => {
  it('`>7.3.5` without a lockfile is queried at 7.3.5 (the stripped floor), `^8` at 8.0.0', async () => {
    narrowStub.dropSafe.mockReturnValue(false);
    const { queries } = await runScan(fetchOsvAdvisories, {
      files: { 'package.json': pkg({ name: 'app', dependencies: { vite: '>7.3.5', react: '^8' } }) },
    });
    expect(queries).toEqual(['react@8.0.0', 'vite@7.3.5']);
  });
});
