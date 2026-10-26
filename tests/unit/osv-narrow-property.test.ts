/**
 * Generated property test for the narrow npm lockfile override.
 *
 * A seeded generator builds small repositories (two or three manifests: root,
 * siblings, nested) and varies, per case: each manifest's declaration (plain
 * range, alias, git spec, tag), its own lockfile (none, v3 matching the range,
 * v3 conflicting with it, v1, malformed, read error 500), a transitive copy of
 * the baseline version in some lockfile, the root package.json (none, plain,
 * with `workspaces`, read error, malformed), a foreign lockfile (kind and
 * location: own directory, ancestor, sibling), a truncated tree and a capped
 * manifest list.
 *
 * Every case runs the real pipeline twice: with the narrow override (head) and
 * with the tree facts withheld, which switches the override off and leaves the
 * unchanged repo-wide chain (base; the scenario table in
 * osv-narrow-scenarios.test.ts pins that base equals the code before the
 * override). Properties:
 *
 *   P1  head contains every base entry except the ones dropped
 *   P2  every dropped (name, version) is installed by no lockfile of the case,
 *       and every manifest declaring the name is narrow for it
 *   P3  the model's own drop oracle agrees with the pipeline in both directions
 *   P4  every added version is what some manifest's own lockfile installs
 *   P5  with a truncated tree, a capped manifest list or a foreign lockfile,
 *       head equals base
 *   P6  names other than vite are untouched
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
import { pkg, runScan, v1, v3, yarn, type Scenario } from './helpers/npm-repo-fixture';

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

type LockState = 'none' | 'v3' | 'v1' | 'malformed' | 'error';
type RootState = 'none' | 'plain' | 'workspaces' | 'error' | 'unparsable';

interface ModelManifest {
  dir: string;
  key: string; // 'vite' or the alias key 'bundler'
  spec: string;
  workspaces?: unknown; // set => a `workspaces` key in this manifest
  lock: LockState;
  lockVersion: string;
  nestedCopy?: string; // an extra nested vite install in this lockfile
}

interface Model {
  manifests: ModelManifest[];
  root: RootState; // package.json at '' when no manifest sits there
  foreign: string[]; // foreign lockfile paths
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

const path = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const isAncestorOrSelf = (anc: string, dir: string) => anc === '' || dir === anc || dir.startsWith(anc + '/');

function generate(rand: () => number): Model {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const layout = pick(LAYOUTS);
  const manifests: ModelManifest[] = layout.map((dir) => {
    const r = rand();
    let spec = pick(SPECS);
    let key = 'vite';
    if (r < 0.1) {
      key = 'bundler';
      spec = 'npm:vite@^7.3.5';
    } else if (r < 0.15) spec = 'github:vitejs/vite#v7.3.5';
    else if (r < 0.2) spec = 'latest';
    const lr = rand();
    const lock: LockState =
      lr < 0.12 ? 'none' : lr < 0.72 ? 'v3' : lr < 0.8 ? 'v1' : lr < 0.9 ? 'malformed' : 'error';
    const range = spec.startsWith('npm:') ? spec.slice('npm:vite@'.length) : spec;
    const satisfying = VERSIONS.filter((v) => semver.validRange(range) && semver.satisfies(v, range));
    const conflicting = VERSIONS.filter((v) => !satisfying.includes(v));
    const wantMatch = rand() < 0.75 && satisfying.length > 0;
    const lockVersion = wantMatch ? pick(satisfying) : pick(conflicting.length ? conflicting : VERSIONS);
    const m: ModelManifest = { dir, key, spec, lock, lockVersion };
    if (rand() < 0.1) m.workspaces = pick([[], ['packages/*'], false, { packages: ['x'] }]);
    if (rand() < 0.15) m.nestedCopy = pick(VERSIONS);
    return m;
  });
  const hasRootManifest = layout.includes('');
  const rr = rand();
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
  if (rand() < 0.2) {
    const dirs = ['', 'a', 'b', 'a/sub', 'tools'];
    foreign.push(path(pick(dirs), pick(FOREIGN)));
  }
  return { manifests, root, foreign, truncated: rand() < 0.08, capped: rand() < 0.05 };
}

function toScenario(model: Model): Scenario {
  const files: Record<string, string> = {};
  const fail: string[] = [];
  for (const m of model.manifests) {
    const body: Record<string, unknown> = { name: `m-${m.dir || 'root'}`, dependencies: { [m.key]: m.spec } };
    if (m.workspaces !== undefined) body.workspaces = m.workspaces;
    files[path(m.dir, 'package.json')] = pkg(body);
    const lockPath = path(m.dir, 'package-lock.json');
    if (m.lock === 'none') continue;
    if (m.lock === 'malformed') files[lockPath] = '{ not json';
    else if (m.lock === 'v1') files[lockPath] = v1({ vite: m.lockVersion });
    else {
      const entries: Record<string, string | { name: string; version: string }> =
        m.key === 'vite'
          ? { 'node_modules/vite': m.lockVersion }
          : { 'node_modules/bundler': { name: 'vite', version: m.lockVersion } };
      if (m.nestedCopy) entries['node_modules/other/node_modules/vite'] = m.nestedCopy;
      files[lockPath] = v3(entries);
      if (m.lock === 'error') fail.push(lockPath);
    }
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
  return { files, fail, truncated: model.truncated, extraManifests: model.capped ? 100 : 0 };
}

// ---- oracle ------------------------------------------------------------------

// Versions of vite installed by a readable lockfile of the model, at any path.
function installedVersions(model: Model): Set<string> {
  const out = new Set<string>();
  for (const m of model.manifests) {
    if (m.lock === 'v3' || m.lock === 'v1' || m.lock === 'error') {
      // 'error' locks exist but are unreadable; callers treat them as unknown separately.
      out.add(m.lockVersion);
      if (m.lock === 'v3' && m.nestedCopy) out.add(m.nestedCopy);
    }
  }
  return out;
}

function hasUnknownLock(model: Model): boolean {
  return model.manifests.some((m) => m.lock === 'malformed' || m.lock === 'error');
}

// Is `m` narrow for vite in the model?
function narrowInModel(model: Model, m: ModelManifest): boolean {
  if (m.lock !== 'v3') return false;
  if (m.spec.startsWith('npm:')) return false;
  if (semver.validRange(m.spec) === null) return false;
  if (!semver.satisfies(m.lockVersion, m.spec, { includePrerelease: true })) return false;
  // workspaces in itself or in any ancestor package.json
  for (const other of model.manifests) {
    if (isAncestorOrSelf(other.dir, m.dir) && other.workspaces !== undefined) return false;
  }
  if (!model.manifests.some((x) => x.dir === '') && model.root !== 'none') {
    if (model.root !== 'plain') return false; // workspaces / error / unparsable
  }
  return true;
}

function dropOracle(model: Model, baseVersion: string): boolean {
  if (model.truncated || model.capped || model.foreign.length > 0) return false;
  if (model.root === 'error' || model.root === 'unparsable') return false;
  if (hasUnknownLock(model)) return false;
  if (!model.manifests.every((m) => narrowInModel(model, m))) return false;
  return !installedVersions(model).has(baseVersion);
}

// ---- the test ----------------------------------------------------------------

const CASES = 600;

describe('narrow override properties (seeded, generated repositories)', () => {
  it(`holds for ${CASES} generated repositories`, async () => {
    const rand = mulberry32(20261026);
    let narrowDrops = 0;
    let keptBase = 0;
    let additionsSeen = 0;
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

      // P1: nothing but the dropped entries is lost (by construction of `dropped`), and dropped
      // entries are only ever of a single (name, version) per name.
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
      }

      // P4: an added version is installed by the own lockfile of a narrow manifest.
      for (const q of added) {
        const v = q.slice(5);
        const ok = model.manifests.some((m) => m.key === 'vite' && m.lockVersion === v && narrowInModel(model, m));
        if (!ok) fail(`P4 added ${q} is not what a narrow manifest's own lockfile installs`);
        additionsSeen++;
      }

      // Determinism.
      const again = (await runScan(fetchOsvAdvisories, scenario)).queries;
      if (JSON.stringify(again) !== JSON.stringify(head)) fail('non-deterministic head');
    }

    // The generator reaches both outcomes (not vacuous).
    expect(narrowDrops).toBeGreaterThan(10);
    expect(keptBase).toBeGreaterThan(50);
    expect(additionsSeen).toBeGreaterThan(50);
    expect(failures.slice(0, 3).join('\n\n')).toBe('');
    expect(failures).toEqual([]);
  }, 120_000);
});
