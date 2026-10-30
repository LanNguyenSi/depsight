/**
 * The npm dependency-age report shows the manifest floor of a package (the
 * lowest declared spec with its range operator stripped), except where the CVE
 * scan's narrow proof (collectNpmReportVersions in lib/cve/osv.ts) holds: every
 * project declaring the package has its own package-lock.json proving its
 * installed version and no lockfile installs the floor. Then the row is the
 * lowest of those versions. The row is never below the floor.
 *
 * End to end through `analyzeDepAge`: only the GitHub client and the npm
 * registry `fetch` are mocked, so discovery, lockfile parsing and the narrow
 * proof run for real. Every test asserts the exact row(s) of the report.
 *
 * Registry (fixed): `vite` latest 8.4.0, published times for 7.3.5, 7.3.7,
 * 8.3.5 and 8.4.0; "now" is 2026-10-26T00:00:00Z.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const requests = vi.hoisted(() => ({ contentPaths: [] as string[], trees: 0 }));

vi.mock('@/lib/github', async () => {
  const real = (await import('./helpers/npm-repo-fixture')).githubMockModule();
  return {
    createGitHubClient: () => {
      const client = real.createGitHubClient();
      const getContent = client.rest.repos.getContent;
      const getTree = client.rest.git.getTree;
      client.rest.repos.getContent = async (args: { path: string }) => {
        requests.contentPaths.push(args.path);
        return getContent(args);
      };
      client.rest.git.getTree = async (args: unknown) => {
        requests.trees += 1;
        return getTree(args as never);
      };
      return client;
    },
  };
});

vi.mock('@/lib/cve/osv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cve/osv')>();
  return { ...actual, collectNpmReportVersions: vi.fn(actual.collectNpmReportVersions) };
});

import { analyzeDepAge } from '@/lib/deps/age-checker';
import { collectNpmReportVersions } from '@/lib/cve/osv';
import { trackDegraded } from '@/lib/scan/degraded';
import { loadRepo, pkg, v1, v3, yarn, type Scenario } from './helpers/npm-repo-fixture';
import { SCENARIOS } from './helpers/npm-scenarios';

const NOW = new Date('2026-10-26T00:00:00Z');

type Registry = Record<string, { latest: string; time: Record<string, string>; versions?: Record<string, { deprecated?: string }> } | 'down' | 'throw'>;

const VITE: Registry[string] = {
  latest: '8.4.0',
  time: {
    '7.3.5': '2026-01-01T00:00:00Z', // 298 days before NOW
    '7.3.7': '2026-02-01T00:00:00Z', // 267 days
    '8.3.5': '2026-06-01T00:00:00Z', // 147 days
    '8.4.0': '2026-10-01T00:00:00Z', // 25 days
  },
};
const LODASH: Registry[string] = {
  latest: '4.17.21',
  time: { '4.17.0': '2020-01-01T00:00:00Z', '4.17.21': '2021-02-20T00:00:00Z' },
};
const registry: Registry = { vite: VITE, lodash: LODASH };

async function report(scenario: Scenario, reg: Registry = registry) {
  loadRepo(scenario);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', ''));
      const entry = reg[name];
      if (entry === 'throw') throw new Error('network');
      if (entry === undefined || entry === 'down') return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: entry.latest },
          time: entry.time,
          ...(entry.versions ? { versions: entry.versions } : {}),
        }),
      };
    }),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { value: result, degraded } = await trackDegraded(() => analyzeDepAge('t', 'o', 'r', 'main'));
    const rows = [...result.dependencies].sort((a, b) => a.name.localeCompare(b.name));
    return { rows, degraded, summary: result.summary };
  } finally {
    warn.mockRestore();
    vi.unstubAllGlobals();
  }
}

/** The fields of a row that the lockfile resolution decides, as a stable shape. */
const shape = (r: Awaited<ReturnType<typeof report>>['rows'][number]) => ({
  name: r.name,
  installedVersion: r.installedVersion,
  publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
  ageInDays: r.ageInDays,
  status: r.status,
  latestVersion: r.latestVersion,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  requests.contentPaths.length = 0;
  requests.trees = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(collectNpmReportVersions).mockClear();
});

const single = (spec: string, lock?: string): Scenario => ({
  files: {
    'package.json': pkg({ name: 'app', dependencies: { vite: spec } }),
    ...(lock ? { 'package-lock.json': lock } : {}),
  },
});

/** The vite row of a report, as the fields the rule decides. */
const viteRow = async (scenario: Scenario, reg: Registry = registry) => {
  const { rows } = await report(scenario, reg);
  return rows.filter((r) => r.name === 'vite').map(shape);
};
const floorRow = {
  name: 'vite',
  installedVersion: '7.3.5',
  publishedAt: '2026-01-01T00:00:00.000Z',
  ageInDays: 298,
  status: 'MAJOR_BEHIND',
  latestVersion: '8.4.0',
};
const raisedRow = {
  name: 'vite',
  installedVersion: '7.3.7',
  publishedAt: '2026-02-01T00:00:00.000Z',
  ageInDays: 267,
  status: 'MAJOR_BEHIND',
  latestVersion: '8.4.0',
};

describe('deps report: a row rises above the floor where every declarer is proven by its own lockfile', () => {
  it('a single project with its own lockfile: the lockfile version, with its age and status', async () => {
    expect(await viteRow(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })))).toEqual([raisedRow]);
  });

  it('age and status follow the resolved version, not the floor (7.3.7 resolved, latest 7.3.9)', async () => {
    const reg: Registry = {
      vite: { latest: '7.3.9', time: { '7.3.5': '2026-01-01T00:00:00Z', '7.3.7': '2026-02-01T00:00:00Z' } },
    };
    // The floor 7.3.5 would be 298 days old; 7.3.7 is 267 days old. Both are OUTDATED against 7.3.9.
    expect(await viteRow(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), reg)).toEqual([
      { ...raisedRow, status: 'OUTDATED', latestVersion: '7.3.9' },
    ]);
  });

  it('resolved version equal to latest is UP_TO_DATE although the floor is behind', async () => {
    const reg: Registry = {
      vite: { latest: '7.3.7', time: { '7.3.5': '2026-01-01T00:00:00Z', '7.3.7': '2026-02-01T00:00:00Z' } },
    };
    const { rows } = await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), reg);
    expect(rows.map((r) => [r.installedVersion, r.status])).toEqual([['7.3.7', 'UP_TO_DATE']]);
  });

  it('two projects (frontend 7.3.7, backend 8.3.5), the floor 7.3.5 installed nowhere: 7.3.7', async () => {
    expect(await viteRow(SCENARIOS.viteGoal)).toEqual([raisedRow]);
  });

  it('a frontend with vite as a dev dependency and a backend that only has it transitively: 7.3.7 and the other packages raised the same way', async () => {
    const reg: Registry = {
      ...registry,
      react: { latest: '19.2.0', time: { '19.0.0': '2026-03-01T00:00:00Z', '19.1.0': '2026-04-01T00:00:00Z' } },
      express: { latest: '5.1.0', time: { '5.1.0': '2026-05-01T00:00:00Z' } },
      vitest: { latest: '4.1.0', time: { '3.2.0': '2026-06-01T00:00:00Z', '3.2.4': '2026-07-01T00:00:00Z' } },
    };
    const { rows } = await report(SCENARIOS.noRootBackendVitePlusFrontendVite, reg);
    expect(rows.map((r) => [r.name, r.installedVersion, r.ageInDays])).toEqual([
      ['express', '5.1.0', 178],
      ['react', '19.1.0', 208],
      ['vite', '7.3.7', 267],
      ['vitest', '3.2.4', 117],
    ]);
  });

  it('vite 7.3.7 (frontend) and 8.3.5 (backend): one row, 7.3.7, the order of the projects does not matter', async () => {
    const swapped: Scenario = {
      files: {
        'frontend/package.json': pkg({ name: 'frontend', dependencies: { vite: '^8.3.0' } }),
        'frontend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
        'backend/package.json': pkg({ name: 'backend', dependencies: { vite: '^7.3.5' } }),
        'backend/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      },
    };
    expect((await viteRow(swapped)).map((r) => r.installedVersion)).toEqual(['7.3.7']);
  });

  it('semver order, not string order: 9.1.5 is lower than 10.0.1 (the floor 9.1.0 is installed nowhere)', async () => {
    const reg: Registry = {
      vite: {
        latest: '10.0.1',
        time: { '9.1.5': '2026-03-01T00:00:00Z', '10.0.1': '2026-09-01T00:00:00Z' },
      },
    };
    const s: Scenario = {
      files: {
        'frontend/package.json': pkg({ name: 'frontend', dependencies: { vite: '^10.0.0' } }),
        'frontend/package-lock.json': v3({ 'node_modules/vite': '10.0.1' }),
        'backend/package.json': pkg({ name: 'backend', dependencies: { vite: '^9.1.0' } }),
        'backend/package-lock.json': v3({ 'node_modules/vite': '9.1.5' }),
      },
    };
    expect(await viteRow(s, reg)).toEqual([
      {
        name: 'vite',
        installedVersion: '9.1.5',
        publishedAt: '2026-03-01T00:00:00.000Z',
        ageInDays: 239,
        status: 'MAJOR_BEHIND',
        latestVersion: '10.0.1',
      },
    ]);
  });

  it('the floor itself is installed by a lockfile: the row is the floor (no proof it is uninstalled)', async () => {
    const s: Scenario = {
      files: {
        'frontend/package.json': pkg({ name: 'frontend', dependencies: { vite: '^7.3.5' } }),
        'frontend/package-lock.json': v3({ 'node_modules/vite': '7.3.5' }),
        'backend/package.json': pkg({ name: 'backend', dependencies: { vite: '^8.3.0' } }),
        'backend/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a partial version floor with the proof: `^8` is raised to the lockfile version, 8.3.5', async () => {
    const { rows } = await report(single('^8', v3({ 'node_modules/vite': '8.3.5' })));
    expect(rows.map((r) => [r.installedVersion, r.ageInDays, r.status])).toEqual([['8.3.5', 147, 'OUTDATED']]);
  });

  it('a partial version floor without the proof (no lockfile): the strip "8", not the range minimum', async () => {
    const { rows } = await report(single('^8'));
    expect(rows.map((r) => [r.installedVersion, r.ageInDays, r.status])).toEqual([['8', -1, 'OUTDATED']]);
  });

  it('a spec with no usable floor (`latest`) keeps its row although a lockfile lists the package', async () => {
    const { rows } = await report(single('latest', v3({ 'node_modules/vite': '7.3.7' })));
    expect(rows.map((r) => [r.installedVersion, r.ageInDays, r.status])).toEqual([['latest', -1, 'UNKNOWN']]);
  });

  it('a lowest lockfile version below the floor is no raise (a `*` project locked at 5.4.0 beside ^7.3.5): the floor', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { vite: '*' } }),
        'a/package-lock.json': v3({ 'node_modules/vite': '5.4.0' }),
        'b/package.json': pkg({ name: 'b', dependencies: { vite: '^7.3.5' } }),
        'b/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a prerelease floor is raised to the prerelease the lockfile installs', async () => {
    const reg: Registry = { vite: { latest: '8.4.0', time: { '7.3.5-beta.2': '2026-05-01T00:00:00Z' } } };
    const { rows } = await report(single('^7.3.5-beta.1', v3({ 'node_modules/vite': '7.3.5-beta.2' })), reg);
    expect(rows.map((r) => [r.installedVersion, r.ageInDays])).toEqual([['7.3.5-beta.2', 178]]);
  });
});

describe('deps report: where a declarer is not proven by its own lockfile the row stays the floor', () => {
  it('a lockfileVersion 1 lockfile (it lists the name, but proves nothing): the floor, not 7.3.7', async () => {
    expect(await viteRow(single('^7.3.5', v1({ vite: '7.3.7' })))).toEqual([floorRow]);
  });

  it('a project whose own lockfile is lockfileVersion 1 beside a project with a version 3 lockfile: the floor', async () => {
    expect(await viteRow(SCENARIOS.negDeclarerLockV1)).toEqual([floorRow]);
  });

  it('a declaring project without a lockfile of its own beside two locked ones: the floor', async () => {
    expect(await viteRow(SCENARIOS.negDeclarerWithoutOwnLock)).toEqual([floorRow]);
  });

  it('a workspaces key in a declaring manifest itself: the floor', async () => {
    expect(await viteRow(SCENARIOS.negWorkspacesKeyInSelf)).toEqual([floorRow]);
  });

  it('a declaring project whose own lockfile cannot be read (500): the floor', async () => {
    expect(await viteRow(SCENARIOS.negDeclarerLockReadError)).toEqual([floorRow]);
  });

  it('an unreadable lockfile in a two-project repository: the floor', async () => {
    const s: Scenario = { ...SCENARIOS.viteGoal, fail: ['frontend/package-lock.json'] };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('an alias in one project (npm:vite@^7.3.5 locked 7.3.7) and a direct vite in another (8.3.5): the floor', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { myvite: 'npm:vite@^7.3.5' } }),
        'a/package-lock.json': v3({ 'node_modules/myvite': { name: 'vite', version: '7.3.7' } }),
        'b/package.json': pkg({ name: 'b', dependencies: { vite: '^8.3.0' } }),
        'b/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('an alias in both projects: the floor', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { myvite: 'npm:vite@^7.3.5' } }),
        'a/package-lock.json': v3({ 'node_modules/myvite': { name: 'vite', version: '7.3.7' } }),
        'b/package.json': pkg({ name: 'b', dependencies: { othervite: 'npm:vite@^8.3.0' } }),
        'b/package-lock.json': v3({ 'node_modules/othervite': { name: 'vite', version: '8.3.5' } }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a lockless sibling beside a project locked inside its own range (^7.3.7 locked 7.3.9, sibling ^7.3.5 without lockfile): 7.3.5, not 7.3.9', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { vite: '^7.3.7' } }),
        'a/package-lock.json': v3({ 'node_modules/vite': '7.3.9' }),
        'b/package.json': pkg({ name: 'b', dependencies: { vite: '^7.3.5' } }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a root project locked at 8.3.5 and a docs project with ^6.0.0 and no lockfile: 6.0.0, not 8.3.5', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'root', dependencies: { vite: '^8.3.0' } }),
        'package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
        'docs/package.json': pkg({ name: 'docs', dependencies: { vite: '^6.0.0' } }),
      },
    };
    const { rows } = await report(s);
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([['vite', '6.0.0']]);
  });

  it('a project that only lists the package as a peer dependency and has no lockfile: the floor (it is a declarer)', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { vite: '^7.3.5' } }),
        'a/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
        'b/package.json': pkg({ name: 'b', peerDependencies: { vite: '^7.3.5' } }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('yarn.lock alone (package.json ^7.3.5, yarn.lock resolving 7.3.7): the floor, since the proof reads package-lock.json only', async () => {
    // The CVE scan queries 7.3.7 for such a repository, but it keeps no proof
    // that a different version is not installed elsewhere; the report shows
    // the floor, as it did before it read lockfiles.
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { vite: '^7.3.5' } }),
        'yarn.lock': yarn([['vite@^7.3.5', '7.3.7']]),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a package-lock.json beside a yarn.lock that agrees: the floor', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { vite: '^7.3.5' } }),
        'package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
        'yarn.lock': yarn([['vite@^7.3.5', '7.3.7']]),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a workspace root whose lockfile covers the member (the member has none of its own): the floor', async () => {
    const { rows } = await report(SCENARIOS.coveringRootLockResolvesMember);
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([['lodash', '4.17.0']]);
  });

  it('the floor is installed as a nested transitive copy in another project lockfile: the floor, vitest raised', async () => {
    const reg: Registry = {
      ...registry,
      vitest: { latest: '4.1.0', time: { '3.2.0': '2026-06-01T00:00:00Z', '3.2.4': '2026-07-01T00:00:00Z' } },
    };
    const { rows } = await report(SCENARIOS.negBaseVersionNestedInOtherLock, reg);
    // vite 7.3.5 is installed (nested under vitest) in the backend lockfile, so it is no floor installed nowhere.
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([
      ['vite', '7.3.5'],
      ['vitest', '3.2.4'],
    ]);
  });

  it('an .npmrc in the tree (it can change what is installed): the floor', async () => {
    const s = { ...SCENARIOS.viteGoal, files: { ...SCENARIOS.viteGoal.files, '.npmrc': 'registry=https://example.invalid/\n' } };
    expect(await viteRow(s)).toEqual([floorRow]);
  });

  it('a package that exists only as a nested copy in a lockfile: the floor', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { vite: '^7.3.5' } }),
        'package-lock.json': v3({ 'node_modules/x/node_modules/vite': '7.3.9' }),
      },
    };
    expect(await viteRow(s)).toEqual([floorRow]);
  });
});

describe('deps report: a declaration outside dependencies and devDependencies keeps the floor', () => {
  // Project a declares vite in `dependencies` and its lockfile proves 7.3.7;
  // project b declares it elsewhere and its lockfile installs 7.3.6, a version
  // the narrow resolution never adds. The row stays the floor, 7.3.5, so the
  // report never shows 7.3.7 for a repository that installs 7.3.6.
  const a = () => ({
    'a/package.json': pkg({ name: 'a', dependencies: { vite: '^7.3.5' } }),
    'a/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
  });
  const beside = (b: object, lock: string = v3({ 'node_modules/vite': '7.3.6' })): Scenario => ({
    files: { ...a(), 'b/package.json': pkg({ name: 'b', ...b }), 'b/package-lock.json': lock },
  });

  it('control: two `dependencies` declarers locked at 7.3.7 and 7.3.6: the lowest, 7.3.6', async () => {
    const { rows, degraded } = await report(beside({ dependencies: { vite: '^7.3.6' } }));
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([['vite', '7.3.6']]);
    expect(degraded).toBeNull();
  });

  it('a `peerDependencies` declarer locked at 7.3.6: the floor, not 7.3.7', async () => {
    expect(await viteRow(beside({ peerDependencies: { vite: '^7.3.6' } }))).toEqual([floorRow]);
  });

  it('an `optionalDependencies` declarer locked at 7.3.6: the floor', async () => {
    expect(await viteRow(beside({ optionalDependencies: { vite: '^7.3.6' } }))).toEqual([floorRow]);
  });

  it('a `bundleDependencies` list naming the package, locked at 7.3.6: the floor', async () => {
    expect(await viteRow(beside({ bundleDependencies: ['vite'] }))).toEqual([floorRow]);
  });

  it('the `bundledDependencies` spelling: the floor', async () => {
    expect(await viteRow(beside({ bundledDependencies: ['vite'] }))).toEqual([floorRow]);
  });

  it('a peer that `peerDependenciesMeta` marks optional, locked at 7.3.6: the floor (optional or not)', async () => {
    const b = { peerDependencies: { vite: '^7.3.6' }, peerDependenciesMeta: { vite: { optional: true } } };
    expect(await viteRow(beside(b))).toEqual([floorRow]);
  });

  it('a peer and a dev declaration in the same manifest: the floor (the peer one is not in dependencies or devDependencies)', async () => {
    const b = { peerDependencies: { vite: '^7.3.6' }, devDependencies: { vite: '^7.3.6' } };
    expect(await viteRow(beside(b))).toEqual([floorRow]);
  });

  it('an `npm:` alias in `peerDependencies` declares its target: the floor', async () => {
    const b = { peerDependencies: { v: 'npm:vite@^7.3.6' } };
    const lock = v3({ 'node_modules/v': { name: 'vite', version: '7.3.6' } });
    expect(await viteRow(beside(b, lock))).toEqual([floorRow]);
  });

  it('a peer declaration of another package is no declaration of this one: raised (a peer-only package has no row)', async () => {
    const b = { dependencies: { vite: '^7.3.6' }, peerDependencies: { lodash: '^4.17.0' } };
    const lock = v3({ 'node_modules/vite': '7.3.6', 'node_modules/lodash': '4.17.21' });
    const { rows } = await report(beside(b, lock));
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([['vite', '7.3.6']]);
  });

  it('a boolean `bundleDependencies` bundles the `dependencies`, which declare the package: raised, not degraded', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { vite: '^7.3.5' }, bundleDependencies: true }),
        'package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
      },
    };
    const { rows, degraded } = await report(s);
    expect(rows.map(shape)).toEqual([raisedRow]);
    expect(degraded).toBeNull();
  });

  it('a `peerDependencies` entry whose spec is not a string: the floor (the manifest proves nothing), not degraded', async () => {
    const { rows, degraded } = await report(beside({ peerDependencies: { vite: 7 } }));
    expect(rows.map(shape)).toEqual([floorRow]);
    expect(degraded).toBeNull();
  });

  it('a `peerDependencies` value that is not an object (null, a string): the floor, not degraded', async () => {
    for (const value of [null, 'vite']) {
      const { rows, degraded } = await report(beside({ peerDependencies: value }));
      expect(rows.map(shape)).toEqual([floorRow]);
      expect(degraded).toBeNull();
    }
  });
});

describe('deps report: the proof is asked for the range minimum, not the strip', () => {
  // The floor the proof must find installed nowhere is the usable manifest
  // floor (`^8` gives 8.0.0, `>=7.3.5 <8` gives 7.3.5); the strip (`8`,
  // `7.3.5 <8`) is no version a lockfile could install, so asking for it would
  // prove any range-only spec.
  it('`^8` locked 8.3.5 with 8.0.0 installed as a nested copy in another project: the strip, `8`', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { vite: '^8' } }),
        'a/package-lock.json': v3({ 'node_modules/vite': '8.3.5' }),
        'b/package.json': pkg({ name: 'b', dependencies: { foo: '^1.0.0' } }),
        'b/package-lock.json': v3({ 'node_modules/foo': '1.0.0', 'node_modules/foo/node_modules/vite': '8.0.0' }),
      },
    };
    const { rows } = await report(s);
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([
      ['foo', '1.0.0'],
      ['vite', '8'],
    ]);
  });

  it('`>=7.3.5 <8` locked 7.3.7 with 7.3.5 installed as a nested copy in another project: the strip', async () => {
    const s: Scenario = {
      files: {
        'a/package.json': pkg({ name: 'a', dependencies: { vite: '>=7.3.5 <8' } }),
        'a/package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
        'b/package.json': pkg({ name: 'b', dependencies: { foo: '^1.0.0' } }),
        'b/package-lock.json': v3({ 'node_modules/foo': '1.0.0', 'node_modules/foo/node_modules/vite': '7.3.5' }),
      },
    };
    const { rows } = await report(s);
    expect(rows.map((r) => [r.name, r.installedVersion])).toEqual([
      ['foo', '1.0.0'],
      ['vite', '7.3.5 <8'],
    ]);
  });
});

describe('deps report: no raise keeps the floor strip', () => {
  it('no lockfile: the spec with its range operator stripped', async () => {
    expect(await viteRow(single('^7.3.5'))).toEqual([floorRow]);
  });

  it('a lockfile without that name (the other package is raised): the floor strip', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { vite: '^7.3.5', 'left-pad': '^1.3.0' } }),
        'package-lock.json': v3({ 'node_modules/left-pad': '1.3.0' }),
      },
    };
    const reg: Registry = { ...registry, 'left-pad': { latest: '1.3.0', time: { '1.3.0': '2026-05-01T00:00:00Z' } } };
    const { rows } = await report(s, reg);
    expect(rows.map(shape)).toEqual([
      {
        name: 'left-pad',
        installedVersion: '1.3.0',
        publishedAt: '2026-05-01T00:00:00.000Z',
        ageInDays: 178,
        status: 'UP_TO_DATE',
        latestVersion: '1.3.0',
      },
      floorRow,
    ]);
  });

  it('a lockfile version that is not a semver version is not shown: the floor strip', async () => {
    const { rows } = await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3' })));
    expect(rows.map((r) => [r.installedVersion, r.ageInDays])).toEqual([['7.3.5', 298]]);
  });
});

describe('deps report: the raised version is not in the registry time map', () => {
  it('ageInDays -1 and no publishedAt, installedVersion and status still from the raised version', async () => {
    const reg: Registry = {
      vite: { latest: '8.4.0', time: { '7.3.5': '2026-01-01T00:00:00Z', '8.4.0': '2026-10-01T00:00:00Z' } },
    };
    // 7.3.5 (the floor) has a time entry; 7.3.7 does not. The age must not fall back to the floor's.
    expect(await viteRow(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), reg)).toEqual([
      { ...raisedRow, publishedAt: null, ageInDays: -1 },
    ]);
  });
});

describe('deps report: precedence of lockfile version, spec floor and registry', () => {
  it('lockfile alone (the spec has no usable floor): the row stays the spec', async () => {
    const { rows } = await report(single('latest', v3({ 'node_modules/vite': '7.3.7' })));
    expect(rows.map((r) => r.installedVersion)).toEqual(['latest']);
  });

  it('spec floor alone (no lockfile): the floor', async () => {
    const { rows } = await report(single('~7.3.5'));
    expect(rows.map((r) => [r.installedVersion, r.ageInDays])).toEqual([['7.3.5', 298]]);
  });

  it('lockfile and spec floor together (the proof holds): the lockfile wins', async () => {
    const { rows } = await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })));
    expect(rows.map((r) => r.installedVersion)).toEqual(['7.3.7']);
  });

  it('lockfile and a registry that does not know the package (404): UNKNOWN row, installedVersion still the raised version', async () => {
    expect(await viteRow(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), { vite: 'down' })).toEqual([
      { ...raisedRow, publishedAt: null, ageInDays: -1, status: 'UNKNOWN', latestVersion: '' },
    ]);
  });

  it('lockfile and a registry request that throws: UNKNOWN row, installedVersion still the raised version', async () => {
    const { rows } = await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), { vite: 'throw' });
    expect(rows.map((r) => [r.installedVersion, r.status])).toEqual([['7.3.7', 'UNKNOWN']]);
  });

  it('spec floor and an unknown registry (no lockfile): UNKNOWN row with the floor', async () => {
    const { rows } = await report(single('^7.3.5'), { vite: 'down' });
    expect(rows.map((r) => [r.installedVersion, r.status])).toEqual([['7.3.5', 'UNKNOWN']]);
  });

  it('a spec without a usable floor and an unknown registry: UNKNOWN row with the spec', async () => {
    const { rows } = await report(single('latest', v3({ 'node_modules/vite': '7.3.7' })), { vite: 'down' });
    expect(rows.map((r) => [r.installedVersion, r.status])).toEqual([['latest', 'UNKNOWN']]);
  });

  it('two lockfiles disagree and the spec has no usable floor: the row stays the spec', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { vite: 'latest' } }),
        'package-lock.json': v3({ 'node_modules/vite': '7.3.7' }),
        'yarn.lock': yarn([['vite@latest', '8.3.5']]),
      },
    };
    const { rows } = await report(s);
    expect(rows.map((r) => [r.installedVersion, r.ageInDays, r.status])).toEqual([['latest', -1, 'UNKNOWN']]);
  });

  it('a deprecated package keeps DEPRECATED, with the raised version', async () => {
    const reg: Registry = { vite: { ...VITE, versions: { '7.3.7': { deprecated: 'use something else' } } } };
    const { rows } = await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), reg);
    expect(rows.map((r) => [r.installedVersion, r.status])).toEqual([['7.3.7', 'DEPRECATED']]);
  });
});

describe('deps report: failures degrade to the floor', () => {
  it('an unreadable lockfile: the floor strip, and the run is reported degraded', async () => {
    const s = { ...single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })), fail: ['package-lock.json'] };
    const { rows, degraded } = await report(s);
    expect(rows.map((r) => r.installedVersion)).toEqual(['7.3.5']);
    expect(degraded).toBe('GitHub file read: HTTP 500: boom');
  });

  it('a resolution that throws: the floor strip, the report is still produced, the run is reported degraded', async () => {
    vi.mocked(collectNpmReportVersions).mockRejectedValueOnce(new Error('boom'));
    const { rows, degraded } = await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })));
    expect(rows.map((r) => [r.installedVersion, r.ageInDays])).toEqual([['7.3.5', 298]]);
    expect(degraded).toBe('npm lockfile resolution: boom');
  });
});

describe('deps report: GitHub requests', () => {
  it('reads each package.json once (the manifests are passed on, not fetched again)', async () => {
    await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })));
    expect(requests.contentPaths.filter((p) => p === 'package.json')).toHaveLength(1);
  });

  it('adds only the lockfile read over the report as it was (one tree, one package.json, one package-lock.json)', async () => {
    await report(single('^7.3.5', v3({ 'node_modules/vite': '7.3.7' })));
    expect(requests.trees).toBe(1);
    expect([...requests.contentPaths].sort()).toEqual(['package-lock.json', 'package.json']);
  });
});
