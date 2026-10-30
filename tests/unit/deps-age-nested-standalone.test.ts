/**
 * The npm dependency-age report and a standalone project nested below an npm
 * workspaces root (the shape of deploy-panel: root `workspaces` [backend,
 * frontend] and a folder `mcp/` beside them with a package-lock.json of its
 * own that the root lockfile does not know).
 *
 * The CVE scan reads such a folder as "unknown how it is installed" and keeps
 * every manifest floor of the whole repository. The age report reads it as a
 * nested standalone project, installed by its own lockfile, when the root's
 * lockfile proves membership at all and says nothing about that folder, and
 * the folder has an own lockfile that parses. The workspace patterns are never
 * evaluated. Measured with bounded real runs (npm 10.9.2 and 11.21.1):
 *
 *   - a folder the patterns do not match: root `npm ci` leaves it alone, `npm
 *     ci` inside it installs its own lockfile;
 *   - a folder the patterns match while the root lockfile lacks it: `npm ci`
 *     refuses (exit 1, "Missing: <name> from lock file") at the root and inside
 *     the folder and installs nothing, so a row from its own lockfile is never
 *     above what is installed;
 *   - a folder a negated pattern excludes: installs its own lockfile.
 *
 * End to end through `analyzeDepAge` (GitHub client and registry `fetch`
 * mocked), plus the two readings side by side at the `resolveNarrowNpm` and
 * `collectNpmReportVersions` level. Precedence: a proven member (root
 * lockfile) wins over everything; a nested standalone project exists only for
 * the report and only where the strict reading says unknown; unknown stays
 * unknown for both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { collectNpmReportVersions } from '@/lib/cve/osv';
import { createGitHubClient } from '@/lib/github';
import {
  addClaimedFolders,
  MAX_MEMBER_FOLDER_CHARS,
  MAX_MEMBER_FOLDER_SEGMENTS,
  resolveNarrowNpm,
  type NarrowNpmInputs,
} from '@/lib/manifest-discovery';
import { installed, knows, NOW, report, type Registry } from './helpers/dep-age-report';
import { loadRepo, pkg, type Scenario } from './helpers/npm-repo-fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const registry: Registry = {
  react: knows('19.0.0', '19.2.6'),
  typescript: knows('5.6.3', '5.8.0', '5.9.3'),
  '@types/node': knows('22.0.0', '22.19.17', '22.19.19'),
  hono: knows('4.13.7', '4.13.13'),
};

const FLOORS = { react: '19.0.0', typescript: '5.6.3', '@types/node': '22.0.0', hono: '4.13.7' };
// react (frontend, root lock), typescript (root and mcp lock, both 5.9.3),
// @types/node (root lock 22.19.19, mcp lock 22.19.17: the lowest), hono (mcp lock).
const RAISED = { react: '19.2.6', typescript: '5.9.3', '@types/node': '22.19.17', hono: '4.13.13' };

const WORKSPACES = ['backend', 'frontend'];
const ROOT_DEV = { typescript: '^5.6.3', '@types/node': '^22.0.0' };
const MCP_DEPS = { hono: '^4.13.7' };
const MCP_DEV = { typescript: '^5.6.3', '@types/node': '^22.0.0' };
const MCP_OVERRIDES = { hono: '^4.13.7', nanoid: '3.3.18' };

const link = (folder: string) => ({ resolved: folder, link: true });

function rootLock(extra: Record<string, unknown> = {}, workspaces: unknown = WORKSPACES): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'deploy-panel', version: '1.0.0', workspaces, devDependencies: ROOT_DEV },
      'node_modules/backend': link('backend'),
      'node_modules/frontend': link('frontend'),
      backend: { name: 'backend', version: '1.0.0', devDependencies: { typescript: '^5.6.3' } },
      frontend: {
        name: 'frontend',
        version: '1.0.0',
        dependencies: { react: '^19.0.0' },
        devDependencies: { '@types/node': '^22.0.0', typescript: '^5.6.3' },
      },
      'node_modules/react': { version: '19.2.6' },
      'node_modules/typescript': { version: '5.9.3' },
      'node_modules/@types/node': { version: '22.19.19' },
      'node_modules/postcss': { version: '8.5.23' },
      'node_modules/nanoid': { version: '3.3.18' },
      ...extra,
    },
  });
}

function mcpLock(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'mcp', version: '1.0.0', dependencies: MCP_DEPS, devDependencies: MCP_DEV },
      'node_modules/hono': { version: '4.13.13' },
      'node_modules/nanoid': { version: '3.3.18' },
      'node_modules/typescript': { version: '5.9.3' },
      'node_modules/@types/node': { version: '22.19.17' },
      ...extra,
    },
  });
}

// The root lockfile of a repository whose patterns name `mcp` and whose lockfile links it: a member.
const MEMBER_PATTERNS = [...WORKSPACES, 'mcp'];
const memberRootLock = () =>
  rootLock(
    {
      'node_modules/mcp': link('mcp'),
      mcp: { name: 'mcp', version: '1.0.0', dependencies: MCP_DEPS, devDependencies: MCP_DEV },
      'node_modules/hono': { version: '4.13.9' },
    },
    MEMBER_PATTERNS,
  );

interface Shape {
  /** the root package.json `workspaces` (the lockfile records WORKSPACES) */
  workspaces?: unknown;
  /** the folder of the nested project, default `mcp` */
  folder?: string;
  rootLockExtra?: Record<string, unknown>;
}

/** deploy-panel: root workspaces [backend, frontend] with a root lockfile, and a nested `mcp/` with its own. */
function deployPanel(shape: Shape = {}): Scenario {
  const folder = shape.folder ?? 'mcp';
  return {
    files: {
      'package.json': pkg({
        name: 'deploy-panel',
        version: '1.0.0',
        private: true,
        workspaces: shape.workspaces ?? WORKSPACES,
        devDependencies: ROOT_DEV,
        overrides: { postcss: '^8.5.23', nanoid: '3.3.18' },
      }),
      'backend/package.json': pkg({ name: 'backend', version: '1.0.0', devDependencies: { typescript: '^5.6.3' } }),
      'frontend/package.json': pkg({
        name: 'frontend',
        version: '1.0.0',
        dependencies: { react: '^19.0.0' },
        devDependencies: { '@types/node': '^22.0.0', typescript: '^5.6.3' },
      }),
      'package-lock.json': rootLock(shape.rootLockExtra),
      [`${folder}/package.json`]: pkg({
        name: 'mcp',
        version: '1.0.0',
        dependencies: MCP_DEPS,
        devDependencies: MCP_DEV,
        overrides: MCP_OVERRIDES,
      }),
      [`${folder}/package-lock.json`]: mcpLock(),
    },
  };
}

const rows = async (s: Scenario) => installed((await report(s, registry)).rows);

// ---- the shape -------------------------------------------------------------------

describe('a nested standalone project below a workspaces root (deploy-panel)', () => {
  it('the rows are what the lockfiles install: the root lockfile for the workspace, the lowest across both for shared names', async () => {
    expect(await rows(deployPanel())).toEqual(RAISED);
  });

  it('the nested project\'s own plain overrides, honoured by its lockfile, do not keep the floor', async () => {
    const s = deployPanel();
    s.files['mcp/package.json'] = pkg({
      name: 'mcp',
      version: '1.0.0',
      dependencies: MCP_DEPS,
      devDependencies: MCP_DEV,
      overrides: { hono: '4.13.13', nanoid: '3.3.18' },
    });
    expect(await rows(s)).toEqual(RAISED);
  });

  it('a plain override the nested lockfile does not honour keeps the floor of every name', async () => {
    const s = deployPanel();
    s.files['mcp/package.json'] = pkg({
      name: 'mcp',
      version: '1.0.0',
      dependencies: MCP_DEPS,
      devDependencies: MCP_DEV,
      overrides: { hono: '4.13.7' },
    });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('the row is per name: a name whose floor the nested lockfile installs keeps the floor, the others rise', async () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = mcpLock({ 'node_modules/typescript': { version: '5.6.3' } });
    expect(await rows(s)).toEqual({ ...RAISED, typescript: '5.6.3' });
  });

  it('a nested folder deeper than one level is the same shape', async () => {
    const s = deployPanel({ folder: 'tools/mcp' });
    expect(await rows(s)).toEqual(RAISED);
  });

  it('a nested lockfile that lists a version below the root lockfile\'s lowers the row, never raises it above either', async () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = mcpLock({ 'node_modules/typescript': { version: '5.8.0' } });
    expect((await rows(s)).typescript).toBe('5.8.0');
  });
});

// ---- what stays at the floor ---------------------------------------------------------

describe('a nested folder the report cannot read as standalone keeps every floor', () => {
  it('no lockfile of its own', async () => {
    const s = deployPanel();
    delete s.files['mcp/package-lock.json'];
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('an own lockfile of version 1', async () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = JSON.stringify({ lockfileVersion: 1, dependencies: { hono: { version: '4.13.13' } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('an own lockfile that does not parse', async () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = '{ not json';
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('an own lockfile that cannot be read', async () => {
    const s: Scenario = { ...deployPanel(), fail: ['mcp/package-lock.json'] };
    const { rows: out, degraded } = await report(s, registry);
    expect(installed(out)).toEqual(FLOORS);
    expect(degraded).not.toBeNull();
  });

  it('an own lockfile that does not list a declaration (stale)', async () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'mcp' }, 'node_modules/typescript': { version: '5.9.3' }, 'node_modules/@types/node': { version: '22.19.17' } },
    });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('an own lockfile that installs a version outside the declared range', async () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = mcpLock({ 'node_modules/hono': { version: '3.0.0' } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('no root lockfile', async () => {
    const s = deployPanel();
    delete s.files['package-lock.json'];
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('a root lockfile that records other workspaces than the root package.json (stale)', async () => {
    const s = deployPanel();
    s.files['package-lock.json'] = rootLock({}, ['other/*']);
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('a root lockfile that records other workspaces: a name only the nested project declares keeps the floor', async () => {
    // no member folder blocks here, so the unproven membership alone decides
    const lock = (workspaces: string[]) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'deploy-panel', version: '1.0.0', workspaces, devDependencies: { typescript: '^5.6.3' } },
          'node_modules/typescript': { version: '5.9.3' },
        },
      });
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'deploy-panel', version: '1.0.0', workspaces: WORKSPACES, devDependencies: { typescript: '^5.6.3' } }),
        'package-lock.json': lock(['other/*']),
        'mcp/package.json': pkg({ name: 'mcp', version: '1.0.0', dependencies: MCP_DEPS }),
        'mcp/package-lock.json': mcpLock(),
      },
    };
    expect((await rows(s)).hono).toBe('4.13.7');
    // the same repository with the lockfile recording the patterns: the nested project is read
    s.files['package-lock.json'] = lock(WORKSPACES);
    expect((await rows(s)).hono).toBe('4.13.13');
  });

  it('a folder whose own spelling has capitals, against a root lockfile entry below it in lower case', async () => {
    const s = deployPanel({ folder: 'Tools', rootLockExtra: { 'tools/node_modules/hono': { version: '4.13.13' } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('a root lockfile of version 1', async () => {
    const s = deployPanel();
    s.files['package-lock.json'] = JSON.stringify({ lockfileVersion: 1, dependencies: { react: { version: '19.2.6' } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('the root lockfile has an entry for the folder (without a link)', async () => {
    const s = deployPanel({ rootLockExtra: { mcp: { name: 'mcp', version: '1.0.0' } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('the root lockfile has an entry below the folder', async () => {
    const s = deployPanel({ rootLockExtra: { 'mcp/node_modules/hono': { version: '4.13.13' } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('the root lockfile has an entry for the folder spelled in another case', async () => {
    const s = deployPanel({ rootLockExtra: { 'MCP/node_modules/hono': { version: '4.13.13' } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('the root lockfile links the folder without an entry for it (the link is unaccounted for)', async () => {
    const s = deployPanel({ rootLockExtra: { 'node_modules/mcp': link('mcp') } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('the root lockfile links another name to the folder', async () => {
    const s = deployPanel({
      rootLockExtra: { 'node_modules/mcp-tools': link('mcp'), mcp: { name: 'mcp-tools', version: '1.0.0' } },
    });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('two workspaces roots above the folder', async () => {
    const s = deployPanel({ folder: 'mcp/app' });
    s.files['mcp/package.json'] = pkg({ name: 'mcp-root', version: '1.0.0', workspaces: ['app'] });
    // the inner root is locked itself (no declarations), so only the second workspaces key keeps the floors
    s.files['mcp/package-lock.json'] = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'mcp-root', workspaces: ['app'] } } });
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('a package.json above the folder that does not parse', async () => {
    const s = deployPanel({ folder: 'mcp/app' });
    s.files['mcp/package.json'] = '{ not json';
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('a non-registry spec anywhere leaves the workspace root unproven', async () => {
    const s = deployPanel();
    s.files['mcp/package.json'] = pkg({
      name: 'mcp',
      version: '1.0.0',
      dependencies: { ...MCP_DEPS, local: 'file:../backend' },
      devDependencies: MCP_DEV,
      overrides: MCP_OVERRIDES,
    });
    expect(await rows(s)).toMatchObject(FLOORS);
  });

  it('a folder nested deeper than a member folder may be (17 segments)', async () => {
    const deep = Array.from({ length: 17 }, (_, i) => `d${i}`).join('/');
    expect(await rows(deployPanel({ folder: deep }))).toEqual(FLOORS);
    // the bound itself: 16 segments still read
    expect(await rows(deployPanel({ folder: deep.split('/').slice(0, 16).join('/') }))).toEqual(RAISED);
  });

  it('a foreign lockfile', async () => {
    const s = deployPanel();
    s.files['yarn.lock'] = '# yarn lockfile v1\n';
    expect(await rows(s)).toEqual(FLOORS);
  });

  it('a name the nested project declares as a peer dependency keeps the floor for that name only', async () => {
    const s = deployPanel();
    s.files['mcp/package.json'] = pkg({
      name: 'mcp',
      version: '1.0.0',
      dependencies: MCP_DEPS,
      devDependencies: { '@types/node': '^22.0.0' },
      peerDependencies: { typescript: '^5.6.3' },
      overrides: MCP_OVERRIDES,
    });
    expect(await rows(s)).toEqual({ ...RAISED, typescript: '5.6.3' });
  });
});

// ---- member, matched-by-pattern and excluded folders --------------------------------------

describe('folders the root lockfile or the patterns decide', () => {
  it('a folder the root lockfile links is a member: the root lockfile decides, its own lockfile and overrides are ignored', async () => {
    const s = deployPanel({ workspaces: MEMBER_PATTERNS });
    s.files['package-lock.json'] = memberRootLock();
    // hono 4.13.9 and @types/node 22.19.19 are the root lockfile's entries; the own lockfile (4.13.13, 22.19.17) is not what installs it
    expect(await rows(s)).toEqual({ ...RAISED, hono: '4.13.9', '@types/node': '22.19.19' });
  });

  it('a folder the patterns match but the root lockfile lacks: npm ci refuses, nothing is installed, the row reads its own lockfile', async () => {
    const s = deployPanel({ workspaces: ['backend', 'frontend', 'm*'] });
    s.files['package-lock.json'] = rootLock({}, ['backend', 'frontend', 'm*']);
    expect(await rows(s)).toEqual(RAISED);
  });

  it('a folder a negated pattern excludes installs its own lockfile', async () => {
    const s = deployPanel({ workspaces: ['*', '!mcp'] });
    s.files['package-lock.json'] = rootLock({}, ['*', '!mcp']);
    expect(await rows(s)).toEqual(RAISED);
  });

  it('no workspaces key at all: standalone as before', async () => {
    const s = deployPanel();
    s.files['package.json'] = pkg({ name: 'deploy-panel', version: '1.0.0', private: true, devDependencies: ROOT_DEV });
    s.files['package-lock.json'] = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'deploy-panel', devDependencies: ROOT_DEV },
        'node_modules/typescript': { version: '5.9.3' },
        'node_modules/@types/node': { version: '22.19.19' },
      },
    });
    delete s.files['backend/package.json'];
    delete s.files['frontend/package.json'];
    expect(await rows(s)).toEqual({ react: undefined, typescript: '5.9.3', '@types/node': '22.19.17', hono: '4.13.13' });
  });
});

// ---- the two readings side by side -------------------------------------------------------------

const gate = (s: Scenario, extra: Partial<NarrowNpmInputs['observedTreeFacts'] & object> = {}) => {
  const paths = Object.keys(s.files).filter((p) => p.endsWith('package.json'));
  const locks = Object.keys(s.files).filter((p) => p.endsWith('package-lock.json'));
  return resolveNarrowNpm({
    manifestPaths: paths,
    manifestFiles: paths.map((path) => ({ path, content: s.files[path] })),
    lockfileFiles: locks.map((path) => ({ path, content: s.files[path] })),
    observedLockfilePaths: { npm: locks, yarn: [] },
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
  it('nested standalone: the strict reading says unknown, the report reads the folder', () => {
    const r = gate(deployPanel());
    for (const [name, floor] of [['react', '19.0.0'], ['typescript', '5.6.3'], ['@types/node', '22.0.0'], ['hono', '4.13.7']]) {
      expect(r.dropSafe(name, floor), `dropSafe ${name}`).toBe(false);
      expect(r.dropSafeForReport(name, floor), `dropSafeForReport ${name}`).toBe(true);
    }
  });

  it('nested standalone: additions stay as the CVE scan had them, additionsForReport hold the nested versions', () => {
    const r = gate(deployPanel());
    expect(r.additions).toEqual([
      { name: 'typescript', version: '5.9.3' },
      { name: '@types/node', version: '22.19.19' },
      { name: 'react', version: '19.2.6' },
    ]);
    expect(r.additionsForReport.slice(0, r.additions.length)).toEqual(r.additions);
    expect(r.additionsForReport.slice(r.additions.length)).toEqual(
      expect.arrayContaining([
        { name: '@types/node', version: '22.19.17' },
        { name: 'hono', version: '4.13.13' },
      ]),
    );
    expect(r.additionsForReport).toHaveLength(r.additions.length + 2);
  });

  it('member (linked in the root lockfile): additions are the same; its own overrides block only the strict reading', () => {
    const s = deployPanel({ workspaces: MEMBER_PATTERNS });
    s.files['package-lock.json'] = memberRootLock();
    const r = gate(s);
    expect(r.additionsForReport).toEqual(r.additions);
    expect(r.dropSafe('react', '19.0.0')).toBe(false);
    expect(r.dropSafeForReport('react', '19.0.0')).toBe(true);
    // without overrides the member is locked for both readings
    s.files['mcp/package.json'] = pkg({ name: 'mcp', version: '1.0.0', dependencies: MCP_DEPS, devDependencies: MCP_DEV });
    const plain = gate(s);
    expect(plain.dropSafe('react', '19.0.0')).toBe(true);
    expect(plain.dropSafeForReport('react', '19.0.0')).toBe(true);
  });

  it('unknown (no own lockfile): both readings false, additions are the same', () => {
    const s = deployPanel();
    delete s.files['mcp/package-lock.json'];
    const r = gate(s);
    expect(r.additionsForReport).toEqual(r.additions);
    expect(r.dropSafe('react', '19.0.0')).toBe(false);
    expect(r.dropSafeForReport('react', '19.0.0')).toBe(false);
  });

  it('unknown (entry below the folder in the root lockfile): both readings false', () => {
    const r = gate(deployPanel({ rootLockExtra: { 'mcp/node_modules/hono': { version: '4.13.13' } } }));
    expect(r.additionsForReport).toEqual(r.additions);
    expect(r.dropSafe('react', '19.0.0')).toBe(false);
    expect(r.dropSafeForReport('react', '19.0.0')).toBe(false);
  });

  it('an .npmrc keeps both readings false, nested standalone or not', () => {
    const r = gate(deployPanel(), { npmrcPaths: ['.npmrc'] });
    expect(r.dropSafe('react', '19.0.0')).toBe(false);
    expect(r.dropSafeForReport('react', '19.0.0')).toBe(false);
  });

  it('the floor installed by the nested lockfile keeps the report gate false for that name', () => {
    const s = deployPanel();
    s.files['mcp/package-lock.json'] = mcpLock({ 'node_modules/typescript': { version: '5.6.3' } });
    const r = gate(s);
    expect(r.dropSafeForReport('typescript', '5.6.3')).toBe(false);
    expect(r.dropSafeForReport('react', '19.0.0')).toBe(true);
  });
});

describe('the CVE channel of collectNpmReportVersions is unchanged', () => {
  it('without the report option the proof is the strict one: no row rises', async () => {
    loadRepo(deployPanel());
    const paths = ['package.json', 'backend/package.json', 'frontend/package.json', 'mcp/package.json'];
    const strict = await collectNpmReportVersions(
      createGitHubClient('t'),
      'o',
      'r',
      paths,
      { npm: ['package-lock.json', 'mcp/package-lock.json'], yarn: [] },
      { foreignLockfilePaths: [], npmrcPaths: [], packageManagerConfigPaths: [], manifestsCapped: false } as NarrowNpmInputs['observedTreeFacts'],
    );
    expect(strict.map((row) => [row.name, row.raisedTo])).toEqual(
      expect.arrayContaining([['react', null], ['typescript', null], ['@types/node', null], ['hono', null]]),
    );
  });
});

// ---- the report reading stays off the CVE path, and its cost is bounded ----------------------

const claimed = (key: string) => {
  const out = new Set<string>();
  addClaimedFolders(key, out);
  return [...out];
};

describe('the folders a root lockfile key claims', () => {
  it('every prefix up to the first node_modules segment, lower-cased', () => {
    expect(claimed('MCP/Tools/node_modules/hono')).toEqual(['mcp', 'mcp/tools']);
    expect(claimed('backend')).toEqual(['backend']);
    expect(claimed('node_modules/hono')).toEqual([]);
    expect(claimed('NODE_MODULES/hono')).toEqual([]);
  });

  it('stops at an empty, dot or dot-dot segment: no longer prefix is a member folder', () => {
    expect(claimed('a//b')).toEqual(['a']);
    expect(claimed('a/./b')).toEqual(['a']);
    expect(claimed('../shared')).toEqual([]);
  });

  it('a key of 100000 segments claims at most MAX_MEMBER_FOLDER_SEGMENTS short folders', () => {
    const out = claimed(Array.from({ length: 100_000 }, () => 'ab').join('/'));
    expect(out).toHaveLength(MAX_MEMBER_FOLDER_SEGMENTS);
    expect(Math.max(...out.map((f) => f.length))).toBeLessThanOrEqual(MAX_MEMBER_FOLDER_CHARS);
  });

  it('the character bound: a folder of exactly MAX_MEMBER_FOLDER_CHARS is claimed, a longer first segment is not', () => {
    const exact = 'a'.repeat(MAX_MEMBER_FOLDER_CHARS);
    expect(claimed(exact)).toEqual([exact]);
    expect(claimed(`${exact}/b`)).toEqual([exact]);
    expect(claimed(`${exact}b/c`)).toEqual([]);
    expect(claimed(`${exact}b`)).toEqual([]);
  });

  it('a long key claims the same short folders as its shortened form', () => {
    const tail = Array.from({ length: 5000 }, () => 'x').join('/');
    expect(claimed(`mcp/${tail}`).slice(0, 3)).toEqual(['mcp', 'mcp/x', 'mcp/x/x']);
  });
});

describe('a root lockfile with one very long key next to a nested standalone project', () => {
  const longKey = Array.from({ length: 100_000 }, () => 'ab').join('/');

  it('the rule is unchanged: the nested project is read, within a time budget', async () => {
    const s = deployPanel({ rootLockExtra: { [longKey]: {} } });
    const started = Date.now();
    const r = gate(s);
    const raised = r.dropSafeForReport('react', '19.0.0');
    const elapsed = Date.now() - started;
    expect(raised).toBe(true);
    expect(r.additionsForReport).toContainEqual({ name: 'hono', version: '4.13.13' });
    expect(elapsed).toBeLessThan(5000);
    expect(await rows(s)).toEqual(RAISED);
  });

  it('a long key below the nested folder still claims the folder', async () => {
    const s = deployPanel({ rootLockExtra: { [`mcp/${longKey}`]: {} } });
    expect(await rows(s)).toEqual(FLOORS);
  });
});

describe('the report list is computed for the report only', () => {
  it('without a strictly unknown manifest it is the CVE list itself', () => {
    const s = deployPanel({ workspaces: MEMBER_PATTERNS });
    s.files['package-lock.json'] = memberRootLock();
    const r = gate(s);
    expect(r.additionsForReport).toBe(r.additions);
  });

  it('with one it is a list of its own, computed once', () => {
    const r = gate(deployPanel());
    expect(r.additionsForReport).not.toBe(r.additions);
    expect(r.additionsForReport).toBe(r.additionsForReport);
  });

  it('it is a getter: reading `additions` and the strict gate never builds it', () => {
    const r = gate(deployPanel());
    expect(typeof Object.getOwnPropertyDescriptor(r, 'additionsForReport')?.get).toBe('function');
    expect(r.dropSafe('react', '19.0.0')).toBe(false);
    expect(r.additions).toHaveLength(3);
  });

  it('a standalone repository without any workspaces key: the same list', () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'p', devDependencies: { typescript: '^5.6.3' } }),
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: { '': { name: 'p', devDependencies: { typescript: '^5.6.3' } }, 'node_modules/typescript': { version: '5.9.3' } },
        }),
      },
    };
    const r = gate(s);
    expect(r.additionsForReport).toBe(r.additions);
    expect(r.additions).toEqual([{ name: 'typescript', version: '5.9.3' }]);
  });
});
