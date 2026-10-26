/**
 * Generated property test for the narrow npm lockfile override.
 *
 * A seeded generator builds small repositories (two or three manifests: root,
 * siblings, nested) and varies, per case:
 *
 *   - each manifest's declaration (plain range, alias, git spec, tag) and its
 *     own lockfile: none, lockfileVersion 1, 2 or 3, an unknown lockfileVersion
 *     (4), no lockfileVersion, version 3 without a `packages` map, malformed
 *     JSON, a read error (HTTP 500)
 *   - the version the lockfile installs (inside or outside the declared range)
 *     and a nested copy of vite in it whose entry is a semver version, a git
 *     URL, a tarball URL, has no version, or is not an object
 *   - a further declared dependency (`ms`) in one of dependencies,
 *     devDependencies, optionalDependencies or peerDependencies that the own
 *     lockfile lists in range, lists out of range, or does not list (a stale
 *     lockfile)
 *   - an `.npmrc` anywhere (also in vendored and build directories, where it is
 *     not read) and a `packageManager` field in a manifest
 *   - the root package.json (none, plain, with `workspaces`, read error,
 *     malformed), a foreign lockfile (kind and location), a truncated tree, a
 *     capped manifest list
 *   - an extra project that names vite in an optional, peer or bundled
 *     declaration or only in `overrides`, with a lockfile of any of the kinds
 *     above and a top-level vite entry of any entry kind
 *
 * Every case runs the real pipeline twice: with the narrow override (head) and
 * with the tree facts withheld, which switches the override off and leaves the
 * unchanged repo-wide chain (base; the scenario table in
 * osv-narrow-scenarios.test.ts pins that base equals the code before the
 * override). The oracle below is written from the drop rule alone and shares no
 * code with the implementation. Properties:
 *
 *   P1  head contains every base entry except the ones dropped
 *   P2  every dropped (name, version) satisfies the oracle's drop rule
 *   P3  the oracle's drop rule is also sufficient: nothing it allows is kept
 *   P4  every added version is what a narrow manifest's own lockfile installs
 *   P5  with a truncated tree, a capped manifest list or a foreign lockfile,
 *       head equals base
 *   P6  names other than vite are untouched
 *   P7  the head set of vite versions is exactly the baseline ones that were
 *       not dropped plus the versions installed for narrow dependencies
 *
 * Non-vacuity: the generator reaches drops, kept floors and additions, and for
 * each varied dimension there are cases where only that dimension keeps the
 * floor (the oracle with that dimension blinded would drop it).
 */
import { describe, it, expect, vi } from 'vitest';
import semver from 'semver';

let STRIP_TREE_FACTS = false;

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());
vi.mock('@/lib/manifest-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifest-discovery')>();
  return {
    ...actual,
    detectEcosystem: async (...args: Parameters<typeof actual.detectEcosystem>) => {
      const info = await actual.detectEcosystem(...args);
      return STRIP_TREE_FACTS ? { ...info, observedTreeFacts: undefined } : info;
    },
  };
});

import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { pkg, runScan, yarn, type Scenario } from './helpers/npm-repo-fixture';

// ---- seeded generator --------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type LockKind = 'none' | 'v1' | 'v2' | 'v3' | 'v4' | 'nover' | 'v3nopackages' | 'malformed' | 'error';
type EntryKind = 'semver' | 'git' | 'tarball' | 'missing' | 'nonobject';
type MsField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
type MsState = 'listed' | 'missing' | 'outOfRange';
type RootState = 'none' | 'plain' | 'workspaces' | 'error' | 'unparsable';

interface ModelManifest {
  dir: string;
  key: string; // 'vite' or the alias key 'bundler'
  spec: string;
  workspaces?: unknown; // set => a `workspaces` key in this manifest
  lock: LockKind;
  lockVersion: string; // what the lockfile installs for the declared key
  nested?: { kind: EntryKind; version: string }; // a nested vite install in this lockfile
  ms?: { field: MsField; state: MsState }; // a further dependency, `ms`
  packageManager?: string;
}

type ExtraField = 'optionalDependencies' | 'peerDependencies' | 'bundleDependencies' | 'overrides';

// A further project in `x/`: it names vite in a field the baseline does not
// query, with a lockfile of its own of any kind.
interface ModelExtra {
  field: ExtraField;
  spec: string;
  lock: LockKind;
  lockVersion: string;
  entry: EntryKind; // the kind of its top-level vite entry
  packageManager?: string;
}

interface Model {
  manifests: ModelManifest[];
  extra?: ModelExtra;
  root: RootState; // package.json at '' when no manifest sits there
  foreign: string[]; // foreign lockfile paths
  npmrc: string[]; // .npmrc paths
  truncated: boolean;
  capped: boolean;
}

const LAYOUTS: string[][] = [
  ['a', 'b'],
  ['', 'a'],
  ['a', 'a/sub'],
  ['a', 'b', 'c'],
  ['', 'a', 'a/sub'],
  ['a', 'b', 'b/sub'],
];
const SPECS = ['^7.3.5', '^8.3.0', '^7.0.0', '~8.3.1', '^6.0.0'];
const VERSIONS = ['5.4.0', '6.3.0', '7.3.5', '7.3.7', '8.3.0', '8.3.5', '8.3.6'];
const FOREIGN = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
const NPMRC_PATHS = ['.npmrc', 'a/.npmrc', 'b/.npmrc', 'x/.npmrc', 'tools/.npmrc', 'node_modules/z/.npmrc', 'dist/.npmrc'];
const MS_FIELDS: MsField[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const GIT_VERSION = 'github:vitejs/vite#abc123';
const TARBALL_VERSION = 'https://example.com/vite.tgz';

const path = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const isAncestorOrSelf = (anc: string, dir: string) => anc === '' || dir === anc || dir.startsWith(anc + '/');

function generate(rand: () => number): Model {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const weighted = <T,>(table: Array<[T, number]>): T => {
    let r = rand();
    for (const [value, weight] of table) {
      if (r < weight) return value;
      r -= weight;
    }
    return table[table.length - 1][0];
  };
  // Half of the cases are calm (a fifth of the perturbation rates), so that
  // drops, which need every condition to hold, are reached often enough.
  const chaos = rand() < 0.5 ? 1 : 0.2;
  const chance = (p: number) => rand() < p * chaos;
  const entryKind = (semverWeight: number): EntryKind =>
    chance(1 - semverWeight) ? pick<EntryKind>(['git', 'tarball', 'missing', 'nonobject']) : 'semver';
  const lockKind = (table: Array<[LockKind, number]>): LockKind => {
    return rand() < chaos ? weighted(table) : 'v3';
  };

  const layout = pick(LAYOUTS);
  const manifests: ModelManifest[] = layout.map((dir) => {
    const r = rand();
    let spec = pick(SPECS);
    let key = 'vite';
    if (r < 0.1 * chaos) {
      key = 'bundler';
      spec = 'npm:vite@^7.3.5';
    } else if (r < 0.15 * chaos) spec = 'github:vitejs/vite#v7.3.5';
    else if (r < 0.2 * chaos) spec = 'latest';
    const lock = lockKind([
      ['none', 0.08],
      ['v3', 0.5],
      ['v2', 0.08],
      ['v1', 0.08],
      ['v4', 0.03],
      ['nover', 0.02],
      ['v3nopackages', 0.02],
      ['malformed', 0.05],
      ['error', 0.05],
    ]);
    const range = spec.startsWith('npm:') ? spec.slice('npm:vite@'.length) : spec;
    const satisfying = VERSIONS.filter((v) => semver.validRange(range) && semver.satisfies(v, range));
    const conflicting = VERSIONS.filter((v) => !satisfying.includes(v));
    const wantMatch = !chance(0.15) && satisfying.length > 0;
    const lockVersion = wantMatch ? pick(satisfying) : pick(conflicting.length ? conflicting : VERSIONS);
    const m: ModelManifest = { dir, key, spec, lock, lockVersion };
    if (chance(0.08)) m.workspaces = pick([[], ['packages/*'], false, { packages: ['x'] }]);
    if (chance(0.2)) m.nested = { kind: entryKind(0.45), version: pick(VERSIONS) };
    return m;
  });
  if (chance(0.3)) {
    pick(manifests).ms = {
      field: pick(MS_FIELDS),
      state: weighted<MsState>([
        ['listed', 0.5],
        ['missing', 0.25],
        ['outOfRange', 0.25],
      ]),
    };
  }
  if (chance(0.06)) pick(manifests).packageManager = pick(['yarn@4.1.0', 'pnpm@9.0.0', 'npm@10.8.0']);

  const hasRootManifest = layout.includes('');
  const rr = chaos === 1 ? rand() : rand() * 0.2;
  const root: RootState = hasRootManifest
    ? 'none'
    : rr < 0.55
      ? 'none'
      : rr < 0.7
        ? 'plain'
        : rr < 0.82
          ? 'workspaces'
          : rr < 0.91
            ? 'error'
            : 'unparsable';
  const foreign: string[] = [];
  if (chance(0.15)) {
    const dirs = ['', 'a', 'b', 'a/sub', 'tools'];
    foreign.push(path(pick(dirs), pick(FOREIGN)));
  }
  const npmrc: string[] = [];
  if (chance(0.1)) npmrc.push(pick(NPMRC_PATHS));
  const extra: ModelExtra | undefined =
    rand() < 0.35
      ? {
          field: pick<ExtraField>(['optionalDependencies', 'peerDependencies', 'bundleDependencies', 'overrides']),
          spec: pick(SPECS),
          lock: lockKind([
            ['none', 0.15],
            ['v3', 0.5],
            ['v2', 0.05],
            ['v1', 0.08],
            ['v4', 0.04],
            ['nover', 0.02],
            ['v3nopackages', 0.02],
            ['malformed', 0.07],
            ['error', 0.07],
          ]),
          lockVersion: pick(VERSIONS),
          entry: entryKind(0.75),
          packageManager: chance(0.04) ? 'yarn@4.1.0' : undefined,
        }
      : undefined;
  return { manifests, extra, root, foreign, npmrc, truncated: chance(0.07), capped: chance(0.04) };
}

// ---- model -> repository -----------------------------------------------------

function entryJson(kind: EntryKind, version: string, alias = false): unknown {
  const named = (e: object) => (alias ? { name: 'vite', ...e } : e);
  switch (kind) {
    case 'semver':
      return named({ version });
    case 'git':
      return named({ version: GIT_VERSION });
    case 'tarball':
      return named({ version: TARBALL_VERSION });
    case 'missing':
      return named({ resolved: 'git+ssh://git@github.com/vitejs/vite.git#abc' });
    case 'nonobject':
      return version;
  }
}

interface LockSpec {
  kind: LockKind;
  key: string; // 'vite' or 'bundler'
  topKind: EntryKind;
  version: string;
  nested?: { kind: EntryKind; version: string };
  ms?: MsState;
}

// The text of a lockfile of the given kind, or null when no file exists.
function lockText(s: LockSpec): string | null {
  if (s.kind === 'none') return null;
  if (s.kind === 'malformed') return '{ not json';
  if (s.kind === 'v3nopackages') return JSON.stringify({ lockfileVersion: 3 });
  const alias = s.key !== 'vite';
  const msVersion = s.ms === 'listed' ? '2.1.3' : s.ms === 'outOfRange' ? '1.0.0' : undefined;
  if (s.kind === 'v1') {
    const topEntry =
      s.topKind === 'semver' && alias ? { version: `npm:vite@${s.version}` } : entryJson(s.topKind, s.version);
    const dependencies: Record<string, unknown> = { [s.key]: topEntry };
    if (msVersion) dependencies.ms = { version: msVersion };
    if (s.nested) {
      dependencies.other = { version: '1.0.0', dependencies: { vite: entryJson(s.nested.kind, s.nested.version) } };
    }
    return JSON.stringify({ lockfileVersion: 1, dependencies });
  }
  const packages: Record<string, unknown> = { '': {}, [`node_modules/${s.key}`]: entryJson(s.topKind, s.version, alias) };
  if (msVersion) packages['node_modules/ms'] = { version: msVersion };
  if (s.nested) {
    packages['node_modules/other'] = { version: '1.0.0' };
    packages['node_modules/other/node_modules/vite'] = entryJson(s.nested.kind, s.nested.version);
  }
  const body: Record<string, unknown> = { packages };
  if (s.kind !== 'nover') body.lockfileVersion = s.kind === 'v4' ? 4 : s.kind === 'v2' ? 2 : 3;
  if (s.kind === 'v2') body.dependencies = {};
  return JSON.stringify(body);
}

function toScenario(model: Model): Scenario {
  const files: Record<string, string> = {};
  const fail: string[] = [];
  const putLock = (dir: string, s: LockSpec) => {
    const text = lockText(s);
    if (text === null) return;
    files[path(dir, 'package-lock.json')] = text;
    if (s.kind === 'error') fail.push(path(dir, 'package-lock.json'));
  };
  for (const m of model.manifests) {
    const body: Record<string, unknown> = { name: `m-${m.dir || 'root'}`, dependencies: { [m.key]: m.spec } };
    if (m.ms) {
      const target = (body[m.ms.field] as Record<string, string> | undefined) ?? {};
      target.ms = '^2.0.0';
      body[m.ms.field] = target;
    }
    if (m.workspaces !== undefined) body.workspaces = m.workspaces;
    if (m.packageManager) body.packageManager = m.packageManager;
    files[path(m.dir, 'package.json')] = pkg(body);
    putLock(m.dir, { kind: m.lock, key: m.key, topKind: 'semver', version: m.lockVersion, nested: m.nested, ms: m.ms?.state });
  }
  if (model.extra) {
    const e = model.extra;
    const body: Record<string, unknown> = { name: 'm-x' };
    if (e.field === 'bundleDependencies') body.bundleDependencies = ['vite'];
    else if (e.field === 'overrides') body.overrides = { vite: e.spec };
    else body[e.field] = { vite: e.spec };
    if (e.packageManager) body.packageManager = e.packageManager;
    files['x/package.json'] = pkg(body);
    putLock('x', { kind: e.lock, key: 'vite', topKind: e.entry, version: e.lockVersion });
  }
  if (!model.manifests.some((m) => m.dir === '')) {
    if (model.root === 'plain') files['package.json'] = pkg({ name: 'root', private: true });
    if (model.root === 'workspaces') files['package.json'] = pkg({ name: 'root', workspaces: ['a', 'b'] });
    if (model.root === 'error') {
      files['package.json'] = pkg({ name: 'root' });
      fail.push('package.json');
    }
    if (model.root === 'unparsable') files['package.json'] = '{ "workspaces": ';
  }
  for (const f of model.foreign) files[f] = f.endsWith('yarn.lock') ? yarn([['left-pad@^1.0.0', '1.0.0']]) : '{}';
  for (const f of model.npmrc) files[f] = 'package-lock=false\n';
  return { files, fail, truncated: model.truncated, extraManifests: model.capped ? 100 : 0 };
}

// ---- oracle (from the drop rule, not from the implementation) ----------------

const KNOWN_SHAPES: LockKind[] = ['v1', 'v2', 'v3'];
const NARROW_SHAPES: LockKind[] = ['v2', 'v3'];
const LOCKED_FIELDS: string[] = ['dependencies', 'devDependencies', 'optionalDependencies'];
const plainRange = (spec: string) => semver.validRange(spec) !== null;
const inRange = (version: string, spec: string) => semver.satisfies(version, spec, { includePrerelease: true });
const rootManifestInLayout = (model: Model) => model.manifests.some((x) => x.dir === '');
const excludedDir = (p: string) => /(^|\/)(node_modules|dist)\//.test('/' + p);

// No `workspaces` key in the manifest at `dir` or in any package.json above it,
// and every package.json above it readable.
function standaloneInModel(model: Model, dir: string): boolean {
  for (const other of model.manifests) {
    if (isAncestorOrSelf(other.dir, dir) && other.workspaces !== undefined) return false;
  }
  if (!rootManifestInLayout(model) && model.root !== 'none') {
    if (model.root !== 'plain') return false; // workspaces / error / unparsable
  }
  return true;
}

// Is `m` narrow for vite? Own lockfile 2/3, plain non-alias range, the installed
// version satisfies it, standalone.
function narrowInModel(model: Model, m: ModelManifest): boolean {
  if (!NARROW_SHAPES.includes(m.lock)) return false;
  if (m.key !== 'vite' || !plainRange(m.spec)) return false;
  if (!inRange(m.lockVersion, m.spec)) return false;
  return standaloneInModel(model, m.dir);
}

// Is the extra project narrow for the vite it names? An `overrides` entry is no
// declaration (the lockfile reflects it), and a bundled name carries no range.
function extraNarrowInModel(model: Model, e: ModelExtra): boolean {
  if (e.field === 'overrides') return true;
  if (!NARROW_SHAPES.includes(e.lock) || e.entry !== 'semver') return false;
  if (!standaloneInModel(model, 'x')) return false;
  if (e.field === 'bundleDependencies') return true;
  return plainRange(e.spec) && inRange(e.lockVersion, e.spec);
}

// Locked: known lockfile shape, and every dependency / devDependency /
// optionalDependency listed at the top level in range (a spec that is no plain
// range only needs the entry).
function manifestLocked(m: ModelManifest): boolean {
  if (!KNOWN_SHAPES.includes(m.lock)) return false;
  if (plainRange(m.spec) && !inRange(m.lockVersion, m.spec)) return false;
  if (m.ms && LOCKED_FIELDS.includes(m.ms.field) && m.ms.state !== 'listed') return false;
  return true;
}

function extraLocked(e: ModelExtra): boolean {
  if (!KNOWN_SHAPES.includes(e.lock)) return false;
  if (e.field !== 'optionalDependencies') return true;
  if (e.entry === 'nonobject') return false;
  return !plainRange(e.spec) || (e.entry === 'semver' && inRange(e.lockVersion, e.spec));
}

// What the lockfiles install: null when some existing lockfile is unparsed,
// unread or of an unknown shape; else the vite versions installed and whether
// some vite entry has a version that cannot be read.
function installIndex(model: Model): { versions: Set<string>; unknownVite: boolean } | null {
  const versions = new Set<string>();
  let unknownVite = false;
  const locks: Array<{ kind: LockKind; top: EntryKind; version: string; nested?: ModelManifest['nested'] }> = [
    ...model.manifests.map((m) => ({ kind: m.lock, top: 'semver' as EntryKind, version: m.lockVersion, nested: m.nested })),
    ...(model.extra ? [{ kind: model.extra.lock, top: model.extra.entry, version: model.extra.lockVersion }] : []),
  ];
  for (const l of locks) {
    if (l.kind === 'none') continue;
    if (!KNOWN_SHAPES.includes(l.kind)) return null;
    if (l.top === 'semver') versions.add(l.version);
    else unknownVite = true;
    if (l.nested) {
      if (l.nested.kind === 'semver') versions.add(l.nested.version);
      else unknownVite = true;
    }
  }
  return { versions, unknownVite };
}

function dropOracle(model: Model, baseVersion: string): boolean {
  if (model.truncated || model.capped || model.foreign.length > 0) return false;
  if (model.npmrc.some((p) => !excludedDir(p))) return false;
  if (model.manifests.some((m) => m.packageManager) || model.extra?.packageManager) return false;
  if (model.root === 'error' || model.root === 'unparsable') return false;
  // A root package.json with no lockfile of its own.
  if (!rootManifestInLayout(model) && model.root !== 'none') return false;
  if (!model.manifests.every(manifestLocked)) return false;
  if (model.extra && !extraLocked(model.extra)) return false;
  const index = installIndex(model);
  if (index === null || index.unknownVite) return false;
  if (!model.manifests.every((m) => narrowInModel(model, m))) return false;
  if (model.extra && !extraNarrowInModel(model, model.extra)) return false;
  return !index.versions.has(baseVersion);
}

// The same model with one dimension made harmless, to show that dimension alone
// can be what keeps a floor (non-vacuity).
type Blinder = 'lockShape' | 'entryKind' | 'staleLock' | 'npmrc' | 'packageManager';
function blind(model: Model, what: Blinder): Model {
  const m: Model = JSON.parse(JSON.stringify(model));
  const shape = (k: LockKind): LockKind => (k === 'v4' || k === 'nover' || k === 'v3nopackages' ? 'v3' : k);
  for (const mf of m.manifests) {
    if (what === 'lockShape') mf.lock = shape(mf.lock);
    if (what === 'entryKind' && mf.nested) mf.nested.kind = 'semver';
    if (what === 'staleLock' && mf.ms) mf.ms.state = 'listed';
    if (what === 'packageManager') delete mf.packageManager;
  }
  if (m.extra) {
    if (what === 'lockShape') m.extra.lock = shape(m.extra.lock);
    if (what === 'entryKind') m.extra.entry = 'semver';
    if (what === 'packageManager') delete m.extra.packageManager;
  }
  if (what === 'npmrc') m.npmrc = [];
  return m;
}
const BLINDERS: Blinder[] = ['lockShape', 'entryKind', 'staleLock', 'npmrc', 'packageManager'];

// ---- the test ----------------------------------------------------------------

const CASES = 12000;

describe('narrow override properties (seeded, generated repositories)', () => {
  it(`holds for ${CASES} generated repositories`, async () => {
    const rand = mulberry32(20261026);
    let narrowDrops = 0;
    let keptBase = 0;
    let additionsSeen = 0;
    const soleBlocker: Record<Blinder, number> = { lockShape: 0, entryKind: 0, staleLock: 0, npmrc: 0, packageManager: 0 };
    const failures: string[] = [];

    for (let i = 0; i < CASES; i++) {
      const model = generate(rand);
      const scenario = toScenario(model);

      STRIP_TREE_FACTS = true;
      const base = (await runScan(fetchOsvAdvisories, scenario)).queries;
      STRIP_TREE_FACTS = false;
      const head = (await runScan(fetchOsvAdvisories, scenario)).queries;
      const note = `case ${i}: ${JSON.stringify(model)}\n  base=${JSON.stringify(base)}\n  head=${JSON.stringify(head)}`;
      const fail = (msg: string) => failures.push(`${msg}\n${note}`);

      const dropped = base.filter((q) => !head.includes(q));
      const added = head.filter((q) => !base.includes(q));

      // P6: names other than vite are untouched.
      for (const q of [...dropped, ...added]) if (!q.startsWith('vite@')) fail(`P6 non-vite change ${q}`);

      // P5: incomplete tree, capped list or foreign lockfile => head equals base.
      if (model.truncated || model.capped || model.foreign.length > 0) {
        if (JSON.stringify(base) !== JSON.stringify(head)) fail('P5 head differs from base');
      }

      // P2 + P3
      const baseVite = base.filter((q) => q.startsWith('vite@')).map((q) => q.slice(5));
      for (const v of baseVite) {
        const oracle = dropOracle(model, v);
        const wasDropped = dropped.includes(`vite@${v}`);
        if (wasDropped && !oracle) fail(`P2 dropped vite@${v} but the oracle says it is not provably uninstalled`);
        if (!wasDropped && oracle) fail(`P3 kept vite@${v} although the oracle says it is droppable`);
        if (wasDropped) narrowDrops++;
        else keptBase++;
        if (!wasDropped && !oracle) {
          for (const b of BLINDERS) if (dropOracle(blind(model, b), v)) soleBlocker[b]++;
        }
      }

      // P4: an added version is installed by the own lockfile of a narrow manifest.
      for (const q of added) {
        const v = q.slice(5);
        const ok = model.manifests.some((m) => m.key === 'vite' && m.lockVersion === v && narrowInModel(model, m));
        if (!ok) fail(`P4 added ${q} is not what a narrow manifest's own lockfile installs`);
        additionsSeen++;
      }

      // P7: the head set is the kept baseline entries plus the narrow additions, nothing else.
      {
        const incomplete = model.truncated || model.capped || model.foreign.length > 0;
        const expectedAdds = incomplete
          ? []
          : model.manifests.filter((m) => m.key === 'vite' && narrowInModel(model, m)).map((m) => m.lockVersion);
        const kept = baseVite.filter((v) => !dropped.includes(`vite@${v}`));
        const expected = [...new Set([...kept, ...expectedAdds])].sort();
        const actual = head.filter((q) => q.startsWith('vite@')).map((q) => q.slice(5)).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(`P7 head vite set ${actual} != expected ${expected}`);
      }

      // Determinism.
      const again = (await runScan(fetchOsvAdvisories, scenario)).queries;
      if (JSON.stringify(again) !== JSON.stringify(head)) fail('non-deterministic head');
    }

    // The generator reaches both outcomes (not vacuous), and each varied
    // dimension is, in some cases, the only thing that keeps a floor.
    expect(narrowDrops).toBeGreaterThan(500);
    expect(keptBase).toBeGreaterThan(500);
    expect(additionsSeen).toBeGreaterThan(500);
    for (const b of BLINDERS) expect(soleBlocker[b], `dimension ${b} is never the sole blocker`).toBeGreaterThan(20);
    expect(failures.slice(0, 3).join('\n\n')).toBe('');
    expect(failures).toEqual([]);
  }, 180_000);
});
