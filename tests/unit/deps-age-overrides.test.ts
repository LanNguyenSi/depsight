/**
 * The npm dependency-age report and `overrides`. The CVE scan treats a manifest
 * with `overrides` it cannot vouch for as not locked and keeps every manifest
 * floor; the age report reads the proof without that block, so a repository
 * whose lockfile installs 19.2.6 for a `^19.0.0` declaration shows 19.2.6 even
 * when a workspace member has `overrides` or the root's `overrides` hold a
 * nested object (the shape of agent-tasks).
 *
 * What stays blocked for the report is everything else the proof needs (foreign
 * lockfiles, `.npmrc`, `packageManager`, a declarer without a lockfile, a floor
 * copy installed anywhere) and one thing about overrides: a plain string
 * override at the root or in a standalone project that its lockfile does not
 * honour, kept as a conservative choice. The row is the top-level lockfile
 * entry of a declared dependency, so it is never above what `npm ci` installs:
 * when `npm ci` accepts the lockfile it installs exactly those entries, when it
 * refuses it nothing is installed from it. Measured with bounded runs against
 * the live registry (npm 10.9.2 and 11.21.1): in a standalone project a stale
 * plain or nested override makes `npm ci` exit 1 ("Invalid: lock file's ms@2.1.2
 * does not satisfy ms@2.1.3"); in a workspace a stale root override (plain or
 * nested) is not enforced against the lockfile and `npm ci` installs the
 * lockfile's ms 2.1.2; a member's `overrides` are ignored. An `npm install`
 * would re-resolve to a stale plain override, hence the floor for that case.
 *
 * End to end through `analyzeDepAge` (GitHub client and registry `fetch`
 * mocked), plus the two gates side by side at the `resolveNarrowNpm` and
 * `collectNpmReportVersions` level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { collectNpmReportVersions } from '@/lib/cve/osv';
import { createGitHubClient } from '@/lib/github';
import { resolveNarrowNpm, type NarrowNpmInputs } from '@/lib/manifest-discovery';
import { installed, knows, NOW, report, type Registry } from './helpers/dep-age-report';
import { loadRepo, pkg, v3, yarn, type Scenario } from './helpers/npm-repo-fixture';
import { SCENARIOS } from './helpers/npm-scenarios';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const registry: Registry = {
  react: knows('19.0.0', '19.1.0', '19.2.6'),
  typescript: knows('5.0.0', '5.4.0', '5.9.3'),
  '@types/node': knows('22.0.0', '22.19.19'),
  next: knows('16.0.0'),
  vite: knows('7.3.5', '7.3.7', '8.3.5'),
};

// ---- the agent-tasks shape: npm workspaces, one root lockfile ---------------------

interface Shape {
  rootOverrides?: unknown;
  memberOverrides?: unknown;
  /** extra root lockfile entries (e.g. a nested copy of a floor) */
  lockExtra?: Record<string, unknown>;
  rootExtra?: Record<string, unknown>;
  files?: Record<string, string>;
}

/**
 * Root `agent-tasks` (react ^19.0.0, next ^16.0.0, typescript ^5.4.0, dev
 * @types/node ^22.0.0) with the member `cli` (typescript ^5.0.0), one root
 * package-lock.json (lockfileVersion 3) installing react 19.2.6, typescript
 * 5.9.3, @types/node 22.19.19 and next 16.0.0 with a nested postcss 8.5.18.
 */
function workspace(shape: Shape = {}): Scenario {
  const rootDeps = { react: '^19.0.0', next: '^16.0.0', typescript: '^5.4.0' };
  const rootDev = { '@types/node': '^22.0.0' };
  const rootJson = {
    name: 'agent-tasks',
    version: '1.0.0',
    private: true,
    workspaces: ['cli'],
    dependencies: rootDeps,
    devDependencies: rootDev,
    ...(shape.rootOverrides !== undefined ? { overrides: shape.rootOverrides } : {}),
    ...shape.rootExtra,
  };
  const memberJson = {
    name: 'cli',
    version: '1.0.0',
    dependencies: { typescript: '^5.0.0' },
    ...(shape.memberOverrides !== undefined ? { overrides: shape.memberOverrides } : {}),
  };
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'agent-tasks', version: '1.0.0', workspaces: ['cli'], dependencies: rootDeps, devDependencies: rootDev },
      'node_modules/cli': { resolved: 'cli', link: true },
      cli: { name: 'cli', version: '1.0.0', dependencies: { typescript: '^5.0.0' } },
      'node_modules/react': { version: '19.2.6' },
      'node_modules/typescript': { version: '5.9.3' },
      'node_modules/@types/node': { version: '22.19.19' },
      'node_modules/next': { version: '16.0.0', dependencies: { postcss: '8.4.31' } },
      'node_modules/next/node_modules/postcss': { version: '8.5.18' },
      ...shape.lockExtra,
    },
  });
  return {
    files: {
      'package.json': pkg(rootJson),
      'cli/package.json': pkg(memberJson),
      'package-lock.json': lock,
      ...shape.files,
    },
  };
}

const NESTED_ROOT = { next: { postcss: '^8.5.18' } };
const MEMBER_PLAIN = { postcss: '^8.5.18' };
const LOCKED = { react: '19.2.6', typescript: '5.9.3', '@types/node': '22.19.19', next: '16.0.0' };
const FLOORS = { react: '19.0.0', typescript: '5.0.0', '@types/node': '22.0.0', next: '16.0.0' };

describe('age row: overrides no longer pin the row to the manifest floor', () => {
  it('control, no overrides anywhere: the lockfile versions (typescript the lowest declared floor 5.0.0 raised to 5.9.3)', async () => {
    const { rows } = await report(workspace(), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('the agent-tasks shape (nested root override and a member with its own overrides): the lockfile versions', async () => {
    const { rows, degraded } = await report(
      workspace({ rootOverrides: NESTED_ROOT, memberOverrides: MEMBER_PLAIN }),
      registry,
    );
    expect(installed(rows)).toEqual(LOCKED);
    expect(degraded).toBeNull();
  });

  it('only a nested root override: the lockfile versions', async () => {
    const { rows } = await report(workspace({ rootOverrides: NESTED_ROOT }), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('only a member override: the lockfile versions (npm ignores a member`s overrides)', async () => {
    const { rows } = await report(workspace({ memberOverrides: MEMBER_PLAIN }), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('a member override that would contradict the lockfile (react 19.0.0) is ignored too: the lockfile versions', async () => {
    const { rows } = await report(workspace({ memberOverrides: { react: '19.0.0' } }), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('age and status follow the lockfile version: react 19.2.6 against latest 19.2.6 is UP_TO_DATE', async () => {
    const { rows } = await report(workspace({ rootOverrides: NESTED_ROOT, memberOverrides: MEMBER_PLAIN }), registry);
    const react = rows.find((r) => r.name === 'react')!;
    expect([react.installedVersion, react.status, react.ageInDays]).toEqual(['19.2.6', 'UP_TO_DATE', 298]);
  });

  it('the declarers of a name in two members, each proven by the root lockfile: the version they install (typescript 5.9.3)', async () => {
    const { rows } = await report(workspace({ rootOverrides: NESTED_ROOT, memberOverrides: MEMBER_PLAIN }), registry);
    expect(installed(rows).typescript).toBe('5.9.3');
  });
});

describe('age row: separate projects take the lowest installed version across declarers, overrides or not', () => {
  const projects = (frontendOverrides?: unknown, backendOverrides?: unknown): Scenario => ({
    files: {
      'frontend/package.json': pkg({
        name: 'frontend',
        dependencies: { vite: '^7.3.5' },
        ...(frontendOverrides !== undefined ? { overrides: frontendOverrides } : {}),
      }),
      'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      'backend/package.json': pkg({
        name: 'backend',
        dependencies: { vite: '^8.3.0' },
        ...(backendOverrides !== undefined ? { overrides: backendOverrides } : {}),
      }),
      'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
    },
  });

  it('control, no overrides: 7.3.7, the lowest of 7.3.7 and 8.3.5', async () => {
    expect(installed((await report(projects(), registry)).rows)).toEqual({ vite: '7.3.7' });
  });

  it('a nested override in one project and a plain, honoured one in the other: still 7.3.7', async () => {
    const lockOfBackendUntouched = projects({ react: { vite: '7.3.7' } }, { vite: '8.3.5' });
    expect(installed((await report(lockOfBackendUntouched, registry)).rows)).toEqual({ vite: '7.3.7' });
  });

  it('a nested override in both projects: still 7.3.7', async () => {
    const both = projects({ x: { y: '1.0.0' } }, { x: { y: '1.0.0' } });
    expect(installed((await report(both, registry)).rows)).toEqual({ vite: '7.3.7' });
  });
});

describe('age row: a floor copy installed anywhere keeps the floor, overrides present too', () => {
  const nestedFloor = (extra: Partial<Shape> = {}) =>
    workspace({
      rootOverrides: NESTED_ROOT,
      memberOverrides: MEMBER_PLAIN,
      lockExtra: { 'node_modules/next/node_modules/react': { version: '19.0.0' } },
      ...extra,
    });

  it('react 19.0.0 installed as a nested copy under next: react stays 19.0.0, the others are raised', async () => {
    const { rows } = await report(nestedFloor(), registry);
    expect(installed(rows)).toEqual({ ...LOCKED, react: '19.0.0' });
  });

  it('the same without overrides: react stays 19.0.0 (the overrides do not change the floor check)', async () => {
    const { rows } = await report(
      workspace({ lockExtra: { 'node_modules/next/node_modules/react': { version: '19.0.0' } } }),
      registry,
    );
    expect(installed(rows)).toEqual({ ...LOCKED, react: '19.0.0' });
  });
});

describe('age row: a plain string override that the lockfile does not honour keeps the floor', () => {
  // Conservative: an `npm install` would install the override's version, so the
  // lockfile's is not certain to be what the project installs.
  it('root override react 19.1.0 against a lockfile holding react 19.2.6: the floors', async () => {
    const { rows } = await report(workspace({ rootOverrides: { react: '19.1.0' } }), registry);
    expect(installed(rows)).toEqual(FLOORS);
  });

  it('root override react ^19.2.0 that the lockfile honours: the lockfile versions', async () => {
    const { rows } = await report(workspace({ rootOverrides: { react: '^19.2.0' } }), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('the stale plain entry comes after a nested one (the scan does not stop at the first non-plain entry): the floors', async () => {
    const { rows } = await report(workspace({ rootOverrides: { ...NESTED_ROOT, react: '19.1.0' } }), registry);
    expect(installed(rows)).toEqual(FLOORS);
  });

  it('the stale plain entry comes before a nested one: the floors', async () => {
    const { rows } = await report(workspace({ rootOverrides: { react: '19.1.0', ...NESTED_ROOT } }), registry);
    expect(installed(rows)).toEqual(FLOORS);
  });

  it('a nested override the lockfile cannot be checked against is accepted (the scan cannot evaluate it): the lockfile versions', async () => {
    // postcss 8.4.31 would violate `next > postcss ^8.5.18`; the scan cannot see that.
    const stale = { 'node_modules/next/node_modules/postcss': { version: '8.4.31' } };
    const { rows } = await report(workspace({ rootOverrides: NESTED_ROOT, lockExtra: stale }), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('a stale nested root override in a workspace with an npm-generated lockfile shape: the row is the lockfile version', async () => {
    // Shape written by `npm install` for root {workspaces:[cli]} with cli depending on debug 4.3.4 (ms 2.1.2 hoisted).
    // The root override {debug:{ms:'2.1.3'}} was added afterwards; `npm ci` (npm 10.9.2 and 11.21.1) exits 0 and installs ms 2.1.2.
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0', workspaces: ['cli'] },
        cli: { name: 'cli', version: '1.0.0', dependencies: { debug: '^4.3.0' } },
        'node_modules/cli': { resolved: 'cli', link: true },
        'node_modules/debug': { version: '4.3.4', dependencies: { ms: '2.1.2' } },
        'node_modules/ms': { version: '2.1.2' },
      },
    });
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'root', version: '1.0.0', private: true, workspaces: ['cli'], overrides: { debug: { ms: '2.1.3' } } }),
        'cli/package.json': pkg({ name: 'cli', version: '1.0.0', dependencies: { debug: '^4.3.0' } }),
        'package-lock.json': lock,
      },
    };
    const reg: Registry = { debug: knows('4.3.0', '4.3.4', '4.4.0') };
    expect(installed((await report(s, reg)).rows)).toEqual({ debug: '4.3.4' });
  });

  it('an empty-string override value is no plain entry (it would read as `*` and reject a prerelease lockfile entry): the lockfile version', async () => {
    const reg: Registry = { react: knows('19.2.6-rc.0', '19.2.6-rc.1') };
    const s = (overrides: unknown): Scenario => ({
      files: {
        'package.json': pkg({ name: 'app', dependencies: { react: '^19.2.6-rc.0' }, overrides }),
        'package-lock.json': v3({ 'node_modules/react': '19.2.6-rc.1' }),
      },
    });
    expect(installed((await report(s({ react: '' }), reg)).rows)).toEqual({ react: '19.2.6-rc.1' });
    expect(installed((await report(s({ react: '  ' }), reg)).rows)).toEqual({ react: '19.2.6-rc.1' });
    // control: a plain `*` the prerelease entry does not satisfy (npm judges it without includePrerelease) keeps the floor
    expect(installed((await report(s({ react: '*' }), reg)).rows)).toEqual({ react: '19.2.6-rc.0' });
  });

  it('a stale member override is no reason for the floor (it is ignored): the lockfile versions', async () => {
    const { rows } = await report(workspace({ memberOverrides: { react: '19.1.0' } }), registry);
    expect(installed(rows)).toEqual(LOCKED);
  });

  it('standalone projects: a stale plain override in an unrelated project (negOverridesStaleLock): the floor', async () => {
    const { rows } = await report(SCENARIOS.negOverridesStaleLock, registry);
    expect(installed(rows).vite).toBe('7.3.5');
  });

  it('standalone projects: the same override reflected in the lockfile (overridesReflectedInLock): raised to 7.3.7', async () => {
    const { rows } = await report(SCENARIOS.overridesReflectedInLock, registry);
    expect(installed(rows).vite).toBe('7.3.7');
  });

  it('standalone projects: a nested object override (negOverridesNestedObject): raised to 7.3.7', async () => {
    const { rows } = await report(SCENARIOS.negOverridesNestedObject, registry);
    expect(installed(rows).vite).toBe('7.3.7');
  });

  it('standalone projects: a `$` reference override (negOverridesDollarReference): raised to 7.3.7', async () => {
    const { rows } = await report(SCENARIOS.negOverridesDollarReference, registry);
    expect(installed(rows).vite).toBe('7.3.7');
  });

  it('a project with overrides and no lockfile of its own (negOverridesNoLock): the floor (no lockfile is no proof)', async () => {
    const { rows } = await report(SCENARIOS.negOverridesNoLock, registry);
    expect(installed(rows).vite).toBe('7.3.5');
  });
});

describe('age row: every other part of the proof still applies beside overrides', () => {
  const both = { rootOverrides: NESTED_ROOT, memberOverrides: MEMBER_PLAIN };

  it('an .npmrc in the tree: the floors', async () => {
    const s = workspace({ ...both, files: { '.npmrc': 'package-lock=false\n' } });
    expect(installed((await report(s, registry)).rows)).toEqual(FLOORS);
  });

  it('a yarn.lock beside the package-lock.json: the floors', async () => {
    const s = workspace({ ...both, files: { 'yarn.lock': yarn([['react@^19.0.0', '19.2.6']]) } });
    expect(installed((await report(s, registry)).rows)).toEqual(FLOORS);
  });

  it('a packageManager field in the root: the floors', async () => {
    const s = workspace({ ...both, rootExtra: { packageManager: 'npm@10.9.2' } });
    expect(installed((await report(s, registry)).rows)).toEqual(FLOORS);
  });

  it('a lockfileVersion 1 root lockfile: the floors', async () => {
    const s = workspace(both);
    s.files['package-lock.json'] = JSON.stringify({ lockfileVersion: 1, dependencies: { react: { version: '19.2.6' } } });
    expect(installed((await report(s, registry)).rows)).toEqual(FLOORS);
  });

  it('no root lockfile: the floors', async () => {
    const s = workspace(both);
    delete s.files['package-lock.json'];
    expect(installed((await report(s, registry)).rows)).toEqual(FLOORS);
  });

  it('an unreadable root lockfile: the floors, reported degraded', async () => {
    const s: Scenario = { ...workspace(both), fail: ['package-lock.json'] };
    const { rows, degraded } = await report(s, registry);
    expect(installed(rows)).toEqual(FLOORS);
    expect(degraded).not.toBeNull();
  });

  it('a declaration outside dependencies/devDependencies (react as a peer of the member): react keeps the floor', async () => {
    const s = workspace(both);
    s.files['cli/package.json'] = pkg({
      name: 'cli',
      version: '1.0.0',
      dependencies: { typescript: '^5.0.0' },
      peerDependencies: { react: '^19.0.0' },
      overrides: MEMBER_PLAIN,
    });
    const { rows } = await report(s, registry);
    expect(installed(rows).react).toBe('19.0.0');
  });
});

// ---- the two gates side by side ---------------------------------------------------

const GATE_FILES = (root: object, member?: object): Record<string, string> => ({
  'package.json': pkg({ name: 'root', version: '1.0.0', workspaces: ['packages/*'], dependencies: { ra: '^1.0.0' }, ...root }),
  'packages/a/package.json': pkg({ name: 'a', version: '1.0.0', dependencies: { ra: '^1.0.0' }, ...(member ?? {}) }),
});
const GATE_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'root', version: '1.0.0', workspaces: ['packages/*'], dependencies: { ra: '^1.0.0' } },
    'node_modules/a': { resolved: 'packages/a', link: true },
    'node_modules/ra': { version: '1.2.0' },
    'packages/a': { name: 'a', version: '1.0.0', dependencies: { ra: '^1.0.0' } },
  },
});
const gate = (files: Record<string, string>, extra: Partial<NarrowNpmInputs['observedTreeFacts'] & object> = {}) => {
  const paths = Object.keys(files).filter((p) => p.endsWith('package.json') && !p.includes('lock'));
  return resolveNarrowNpm({
    manifestPaths: paths,
    manifestFiles: paths.map((path) => ({ path, content: files[path] })),
    lockfileFiles: [{ path: 'package-lock.json', content: GATE_LOCK }],
    observedLockfilePaths: { npm: ['package-lock.json'], yarn: [] },
    observedTreeFacts: {
      foreignLockfilePaths: [],
      npmrcPaths: [],
      packageManagerConfigPaths: [],
      manifestsCapped: false,
      ...extra,
    } as NarrowNpmInputs['observedTreeFacts'],
  });
};

describe('the strict gate (CVE scan) and the report gate side by side', () => {
  const cases: Array<[string, object, object | undefined, boolean, boolean]> = [
    // name, root extra, member extra, dropSafe (strict), dropSafeForReport
    ['no overrides', {}, undefined, true, true],
    ['a plain honoured root override', { overrides: { ra: '1.2.0' } }, undefined, true, true],
    ['a nested root override', { overrides: { next: { postcss: '^8.5.18' } } }, undefined, false, true],
    ['a member override', {}, { overrides: { postcss: '^8.5.18' } }, false, true],
    ['a nested root and a member override together', { overrides: { next: { postcss: '^8.5.18' } } }, { overrides: { x: '1.0.0' } }, false, true],
    ['a plain root override the lockfile does not honour', { overrides: { ra: '1.1.0' } }, undefined, false, false],
    ['a stale plain entry after a nested one', { overrides: { next: { postcss: '^8.5.18' }, ra: '1.1.0' } }, undefined, false, false],
  ];
  for (const [label, root, member, strict, forReport] of cases) {
    it(`${label}: dropSafe ${strict}, dropSafeForReport ${forReport}`, () => {
      const r = gate(GATE_FILES(root, member));
      expect(r.dropSafe('ra', '1.0.0')).toBe(strict);
      expect(r.dropSafeForReport('ra', '1.0.0')).toBe(forReport);
    });
  }

  it('the floor installed in the lockfile keeps both gates false', () => {
    const r = gate(GATE_FILES({ overrides: { next: { postcss: '^8.5.18' } } }));
    expect(r.dropSafe('ra', '1.2.0')).toBe(false);
    expect(r.dropSafeForReport('ra', '1.2.0')).toBe(false);
  });

  it('an .npmrc keeps both gates false, overrides or not', () => {
    for (const root of [{}, { overrides: { next: { postcss: '^8.5.18' } } }]) {
      const r = gate(GATE_FILES(root), { npmrcPaths: ['.npmrc'] });
      expect(r.dropSafe('ra', '1.0.0')).toBe(false);
      expect(r.dropSafeForReport('ra', '1.0.0')).toBe(false);
    }
  });

  it('additions are the same for both gates', () => {
    const r = gate(GATE_FILES({ overrides: { next: { postcss: '^8.5.18' } } }, { overrides: { x: '1.0.0' } }));
    expect(r.additions).toEqual([{ name: 'ra', version: '1.2.0' }]);
  });
});

describe('collectNpmReportVersions: which gate decides (the option against the default)', () => {
  const files = GATE_FILES({ overrides: { next: { postcss: '^8.5.18' } } });
  const rows = async (options?: { overridesDoNotBlock?: boolean }) => {
    const scenario: Scenario = { files: { ...files, 'package-lock.json': GATE_LOCK } };
    loadRepo(scenario);
    return collectNpmReportVersions(
      createGitHubClient('t'),
      'o',
      'r',
      ['package.json', 'packages/a/package.json'],
      { npm: ['package-lock.json'], yarn: [] },
      { foreignLockfilePaths: [], npmrcPaths: [], packageManagerConfigPaths: [], manifestsCapped: false } as never,
      undefined,
      options,
    );
  };

  it('option unset: the CVE scan`s gate wins, the nested root override blocks (raisedTo null)', async () => {
    expect(await rows()).toEqual([{ name: 'ra', strip: '1.0.0', raisedTo: null }]);
  });

  it('option false: same as unset', async () => {
    expect(await rows({ overridesDoNotBlock: false })).toEqual([{ name: 'ra', strip: '1.0.0', raisedTo: null }]);
  });

  it('option true: the report gate wins (raisedTo 1.2.0)', async () => {
    expect(await rows({ overridesDoNotBlock: true })).toEqual([{ name: 'ra', strip: '1.0.0', raisedTo: '1.2.0' }]);
  });
});
