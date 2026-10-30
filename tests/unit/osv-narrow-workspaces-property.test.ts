/**
 * Generated property test for the narrow npm lockfile override in npm
 * workspace repositories (task b031d380).
 *
 * A seeded generator builds a workspace (root at the repository root, or at
 * `ws/` below a plain root package.json beside a standalone project `app/`)
 * with one to three members and varies, per case:
 *
 *   - the root lockfile: lockfileVersion 3, 2 or 1, missing, malformed, a
 *     read error; whether its root entry records the package.json
 *     `workspaces` value (the same, none, another one), and that value's shape
 *     (an array, the object form, or one npm does not read)
 *   - per member: its name (none, one no link can address, the same as another
 *     member's), its folder entry and its link entry (exact, missing, resolving
 *     elsewhere), the field and spec it declares vite in (dependencies,
 *     devDependencies, optional, peer, bundled; a plain range, an alias, a git
 *     spec), a copy of vite under its own folder, `overrides`, a dependency on
 *     the first member (in range, out of range, or with a version that differs
 *     from the lockfile's folder entry), a further dependency `ms` listed in
 *     range, out of range or not listed
 *   - the versions installed at the top level, as a transitive copy, and in a
 *     folder between a member and the root
 *   - a link entry outside the repository or to a folder the scan does not
 *     read, a manifest below the root that is no member, `.npmrc`, a foreign
 *     lockfile, a truncated tree
 *   - a dependency spec that is no registry spec (a git edge of a root
 *     lockfile entry, a `file:` dependency of a member, a git dependency of
 *     the standalone project beside the workspace), which leaves every
 *     workspace root unproven
 *
 * Each case runs the real pipeline with the override (head) and with the tree
 * facts withheld, which switches it off (base). The oracle below is written
 * from the rule alone, with semver only, and calls nothing of the code under
 * test. Properties:
 *
 *   W1  nothing but vite changes, and head holds every base entry except the
 *       vite versions it drops
 *   W2  every dropped vite version satisfies the oracle's drop rule
 *   W3  the drop rule is sufficient: nothing it allows is kept
 *   W4  the head vite set is exactly the kept base versions plus the versions
 *       the oracle's narrow declarers resolve
 *   W5  with a truncated tree or a foreign lockfile, head equals base
 *   W6  the dependency-age row for vite is never below the base row, and is
 *       exactly the oracle's row
 *
 * Non-vacuity: drops, kept floors and raised rows are reached, and each varied
 * dimension is in some cases the only thing that keeps a floor.
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
import { analyzeDepAge } from '@/lib/deps/age-checker';
import { loadRepo, pkg, runScan, yarn, type Scenario } from './helpers/npm-repo-fixture';

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

type LockKind = 'v3' | 'v2' | 'v1' | 'none' | 'malformed' | 'error';
type Recorded = 'same' | 'absent' | 'other';
type WsShape = 'array' | 'object' | 'empty' | 'false' | 'string';
type Field = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies' | 'bundleDependencies' | 'none';
type LinkKind = 'exact' | 'missing' | 'wrong';
type NameKind = 'ok' | 'none' | 'unlinkable';
type MemberDep = 'none' | 'inRange' | 'outOfRange';
type MsState = 'listed' | 'missing' | 'outOfRange';
type Stray = 'none' | 'outside' | 'unread';
type Unsafe = 'none' | 'lockEdge' | 'memberDep' | 'appDep';

interface ModelMember {
  folder: string; // relative to the workspace root
  nameKind: NameKind;
  name: string; // the name it would have; used only when nameKind is 'ok' (or 'unlinkable': '../<name>')
  folderEntry: boolean;
  link: LinkKind;
  field: Field;
  spec: string; // a plain range, or ALIAS_SPEC / GIT_SPEC
  ownCopy?: string; // version at <folder>/node_modules/vite
  overrides: boolean;
  dep: MemberDep; // a dependency on the first member
  ms?: MsState; // a further dependency `ms` (^2.0.0) in dependencies
}

interface Model {
  rootDir: '' | 'ws';
  shape: WsShape;
  recorded: Recorded;
  lock: LockKind;
  rootField: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
  rootSpec: string;
  hoisted: string | null;
  transitive: string | null;
  between: string | null; // packages/group/node_modules/vite
  firstVersionMismatch: boolean; // the first member's package.json version differs from its folder entry
  members: ModelMember[];
  stray: Stray;
  nonMember: boolean;
  app?: { spec: string; version: string };
  npmrc: boolean;
  foreign: boolean;
  truncated: boolean;
  unsafe: Unsafe; // a spec other than a registry spec, outside vite
}

const SPECS = ['^7.3.5', '^7.0.0', '^8.3.0', '~8.3.1', '^6.0.0', '^7.3.5-beta.1'];
const VERSIONS = ['6.3.0', '7.0.0', '7.3.5', '7.3.5-beta.2', '7.3.7', '8.3.0', '8.3.5', '8.3.6'];
const ALIAS_SPEC = 'npm:vite@^7.0.0';
const GIT_SPEC = 'github:vitejs/vite#v7.3.7';
const GIT_DEP = 'github:o/gitdep';
const FILE_DEP = 'file:../local';
const FOLDERS = ['packages/m1', 'packages/m2', 'packages/group/m3'];
const MS_LISTED = '2.1.3';
const MS_OUT = '1.0.0';

function generate(rand: () => number): Model {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  // Half of the cases are calm (a fifth of the perturbation rates), so that
  // drops, which need every condition to hold, are reached often enough.
  const chaos = rand() < 0.5 ? 1 : 0.15;
  const chance = (p: number) => rand() < p * chaos;
  const rootDir: '' | 'ws' = rand() < 0.3 ? 'ws' : '';
  const hoisted = chance(0.05) ? null : pick(VERSIONS);
  const memberCount = 1 + Math.floor(rand() * 3);
  const members: ModelMember[] = [];
  for (let i = 0; i < memberCount; i++) {
    const r = rand();
    const field: Field = chance(0.35)
      ? pick<Field>(['optionalDependencies', 'peerDependencies', 'bundleDependencies', 'none', 'devDependencies'])
      : 'dependencies';
    const spec = chance(0.08) ? ALIAS_SPEC : chance(0.05) ? GIT_SPEC : r < 0.5 && hoisted && SPECS.some((s) => semver.satisfies(hoisted, s)) ? pick(SPECS.filter((s) => semver.satisfies(hoisted, s))) : pick(SPECS);
    members.push({
      folder: FOLDERS[i],
      nameKind: chance(0.05) ? 'none' : chance(0.05) ? 'unlinkable' : 'ok',
      name: `m${i + 1}`,
      folderEntry: !chance(0.07),
      link: chance(0.1) ? pick<LinkKind>(['missing', 'wrong']) : 'exact',
      field,
      spec,
      ownCopy: chance(0.12) ? pick(VERSIONS) : undefined,
      overrides: chance(0.05),
      dep: i === 0 ? 'none' : rand() < 0.5 ? (chance(0.4) ? 'outOfRange' : 'inRange') : 'none',
    });
  }
  if (chance(0.3)) pick(members).ms = pick<MsState>(['listed', 'listed', 'missing', 'outOfRange']);
  if (memberCount >= 2 && chance(0.05)) members[1].name = members[0].name; // duplicate name
  const rootSpec = hoisted && rand() < 0.6 && SPECS.some((s) => semver.satisfies(hoisted, s)) ? pick(SPECS.filter((s) => semver.satisfies(hoisted, s))) : pick(SPECS);
  return {
    rootDir,
    shape: chance(0.1) ? pick<WsShape>(['empty', 'false', 'string', 'object']) : rand() < 0.15 ? 'object' : 'array',
    recorded: chance(0.12) ? pick<Recorded>(['absent', 'other']) : 'same',
    lock: chance(0.15) ? pick<LockKind>(['v2', 'v1', 'none', 'malformed', 'error']) : 'v3',
    rootField: chance(0.2) ? pick(['dependencies', 'optionalDependencies', 'peerDependencies'] as const) : 'devDependencies',
    rootSpec,
    hoisted,
    transitive: rand() < 0.5 ? pick(VERSIONS) : null,
    between: chance(0.2) ? pick(VERSIONS) : null,
    firstVersionMismatch: chance(0.3),
    members,
    stray: chance(0.08) ? pick<Stray>(['outside', 'unread']) : 'none',
    nonMember: chance(0.06),
    app: rootDir === 'ws' ? { spec: pick(SPECS), version: pick(VERSIONS) } : undefined,
    npmrc: chance(0.05),
    foreign: chance(0.05),
    truncated: chance(0.04),
    unsafe: chance(0.08) ? pick<Unsafe>(['lockEdge', 'memberDep', 'appDep']) : 'none',
  };
}

// ---- model -> repository -----------------------------------------------------

const join = (...parts: string[]) => parts.filter((p) => p !== '').join('/');
const basename = (folder: string) => folder.split('/').pop()!;
const memberNameOf = (m: ModelMember): string | null => (m.nameKind === 'ok' ? m.name : m.nameKind === 'unlinkable' ? `../${m.name}` : null);
const memberKey = (m: ModelMember) => (m.spec === ALIAS_SPEC ? 'myvite' : 'vite');
const memberVersion = (model: Model, i: number) => (i === 0 && model.firstVersionMismatch ? '1.1.0' : '1.0.0');
const wsValue = (shape: WsShape): unknown =>
  shape === 'array' ? ['packages/*', 'packages/group/*'] : shape === 'object' ? { packages: ['packages/*', 'packages/group/*'] } : shape === 'empty' ? [] : shape === 'false' ? false : 'packages/*';
const depSpec = (dep: MemberDep) => (dep === 'outOfRange' ? '^2.0.0' : '^1.0.0');

// The link entries the root lockfile carries, first member wins a key.
function linkEntries(model: Model): Map<string, { resolved: string; member: number }> {
  const links = new Map<string, { resolved: string; member: number }>();
  model.members.forEach((m, i) => {
    if (m.link === 'missing') return;
    const key = `node_modules/${memberNameOf(m) ?? basename(m.folder)}`;
    if (links.has(key)) return;
    links.set(key, { resolved: m.link === 'exact' ? m.folder : `${m.folder}/`, member: i });
  });
  return links;
}

function rootLockText(model: Model): string | null {
  if (model.lock === 'none') return null;
  if (model.lock === 'malformed') return '{ not json';
  if (model.lock === 'v1') return JSON.stringify({ lockfileVersion: 1, dependencies: model.hoisted ? { vite: { version: model.hoisted } } : {} });
  const root: Record<string, unknown> = { name: 'root' };
  if (model.recorded === 'same') root.workspaces = wsValue(model.shape);
  if (model.recorded === 'other') root.workspaces = ['other/*'];
  const packages: Record<string, unknown> = { '': root };
  if (model.hoisted) packages['node_modules/vite'] = { version: model.hoisted };
  if (model.transitive) {
    packages['node_modules/other'] = { version: '1.0.0' };
    packages['node_modules/other/node_modules/vite'] = { version: model.transitive };
  }
  if (model.between) packages['packages/group/node_modules/vite'] = { version: model.between };
  if (model.members.some((m) => m.spec === ALIAS_SPEC) && model.hoisted) packages['node_modules/myvite'] = { name: 'vite', version: model.hoisted };
  const ms = model.members.find((m) => m.ms)?.ms;
  if (ms === 'listed') packages['node_modules/ms'] = { version: MS_LISTED };
  if (ms === 'outOfRange') packages['node_modules/ms'] = { version: MS_OUT };
  model.members.forEach((m, i) => {
    const name = memberNameOf(m);
    if (m.folderEntry) packages[m.folder] = name === null ? { version: '1.0.0' } : { name, version: '1.0.0' };
    if (m.ownCopy) packages[`${m.folder}/node_modules/vite`] = { version: m.ownCopy };
    void i;
  });
  for (const [key, { resolved }] of linkEntries(model)) packages[key] = { resolved, link: true };
  if (model.stray === 'outside') {
    packages['node_modules/shared'] = { resolved: '../shared', link: true };
    packages['../shared'] = { name: 'shared', version: '1.0.0' };
  }
  if (model.stray === 'unread') {
    packages['node_modules/tool'] = { resolved: 'tools/tool', link: true };
    packages['tools/tool'] = { name: 'tool', version: '1.0.0' };
  }
  if (model.unsafe === 'lockEdge') {
    packages['node_modules/carrier'] = { version: '1.0.0', dependencies: { gitdep: GIT_DEP } };
    packages['node_modules/gitdep'] = { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/gitdep.git#abc' };
  }
  if (model.unsafe === 'memberDep') packages['node_modules/local'] = { version: '1.0.0' };
  return JSON.stringify({ lockfileVersion: model.lock === 'v2' ? 2 : 3, requires: true, packages });
}

function toScenario(model: Model): Scenario {
  const files: Record<string, string> = {};
  const fail: string[] = [];
  const at = (rel: string) => join(model.rootDir, rel);
  files[at('package.json')] = pkg({ name: 'root', private: true, workspaces: wsValue(model.shape), [model.rootField]: { vite: model.rootSpec } });
  const lockText = rootLockText(model);
  if (lockText !== null) {
    files[at('package-lock.json')] = lockText;
    if (model.lock === 'error') fail.push(at('package-lock.json'));
  }
  const first = model.members[0];
  model.members.forEach((m, i) => {
    const body: Record<string, unknown> = { version: memberVersion(model, i) };
    const name = memberNameOf(m);
    if (name !== null) body.name = name;
    const deps: Record<string, string> = {};
    if (m.field === 'bundleDependencies') body.bundleDependencies = ['vite'];
    else if (m.field !== 'none') body[m.field] = { [memberKey(m)]: m.spec };
    if (m.dep !== 'none' && memberNameOf(first) !== null) deps[memberNameOf(first)!] = depSpec(m.dep);
    if (m.ms) deps.ms = '^2.0.0';
    if (i === 0 && model.unsafe === 'memberDep') deps.local = FILE_DEP;
    if (Object.keys(deps).length > 0) {
      body.dependencies = { ...((body.dependencies as Record<string, string> | undefined) ?? {}), ...deps };
    }
    if (m.overrides) body.overrides = { vite: model.hoisted ?? '7.3.7' };
    files[at(join(m.folder, 'package.json'))] = pkg(body);
  });
  if (model.nonMember) {
    files[at('packages/m1/examples/demo/package.json')] = pkg({ name: 'demo', dependencies: { vite: '^7.0.0' } });
    files[at('packages/m1/examples/demo/package-lock.json')] = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/vite': { version: '7.3.7' } } });
  }
  if (model.rootDir === 'ws') {
    files['package.json'] = pkg({ name: 'top', private: true });
    files['package-lock.json'] = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'top' } } });
    if (model.app) {
      const appGit = model.unsafe === 'appDep';
      files['app/package.json'] = pkg({ name: 'app', dependencies: { vite: model.app.spec, ...(appGit ? { gitdep: GIT_DEP } : {}) } });
      files['app/package-lock.json'] = JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { name: 'app' }, 'node_modules/vite': { version: model.app.version }, ...(appGit ? { 'node_modules/gitdep': { version: '1.0.0' } } : {}) },
      });
    }
  }
  if (model.npmrc) files['.npmrc'] = 'package-lock=false\n';
  if (model.foreign) files['yarn.lock'] = yarn([['left-pad@^1.0.0', '1.0.0']]);
  return { files, fail, truncated: model.truncated };
}

// ---- oracle (from the rule, semver only) -------------------------------------

// npm judges a lockfile against a declared range in loose mode and without includePrerelease.
const inRange = (version: string | null | undefined, spec: string) =>
  version != null && semver.satisfies(version, spec, { loose: true, includePrerelease: false });
const plainRange = (spec: string) => semver.validRange(spec, true) !== null;
const LOCK_REQUIRED: Field[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

interface Facts {
  membersProven: boolean; // the root lockfile proves membership at all
  proven: boolean[]; // per member
}

// A spec other than a registry spec anywhere the scan reads (a read
// manifest, or an entry of the root lockfile) leaves every workspace root
// unproven: the member's git spec for vite in one of the four dependency maps,
// or the `unsafe` dimension where the model writes it (the git edge only into a
// lockfile of version 2 or 3, the standalone project only beside a root in ws/).
function unsafeSpecAnywhere(model: Model): boolean {
  if (model.members.some((m) => m.spec === GIT_SPEC && LOCK_REQUIRED.includes(m.field))) return true;
  if (model.unsafe === 'memberDep') return true;
  if (model.unsafe === 'lockEdge') return model.lock === 'v3' || model.lock === 'v2';
  return model.unsafe === 'appDep' && model.app !== undefined;
}

function facts(model: Model): Facts {
  const lockOk = (model.lock === 'v3' || model.lock === 'v2') && (model.shape === 'array' || model.shape === 'object') && model.recorded === 'same' && !unsafeSpecAnywhere(model);
  const links = linkEntries(model);
  const proven = model.members.map((m, i) => {
    if (m.nameKind !== 'ok' || !m.folderEntry || m.link !== 'exact') return false;
    const link = links.get(`node_modules/${m.name}`);
    return link !== undefined && link.member === i;
  });
  const provenFolders = new Set(model.members.filter((_, i) => proven[i]).map((m) => m.folder));
  const accounted = model.stray === 'none' && [...links.values()].every((l) => provenFolders.has(l.resolved));
  return { membersProven: lockOk && accounted, proven };
}

// The entry a member resolves vite (or `key`) from: own copy, else null when a
// folder between has a copy, else the top level.
function memberViteVersion(model: Model, m: ModelMember): { at: 'own' | 'between' | 'top'; version: string | null } {
  if (m.ownCopy) return { at: 'own', version: m.ownCopy };
  if (model.between && m.folder.startsWith('packages/group/')) return { at: 'between', version: model.between };
  return { at: 'top', version: model.hoisted };
}

function memberLocked(model: Model, f: Facts, i: number): boolean {
  const m = model.members[i];
  if (!f.membersProven || !f.proven[i]) return false;
  if (m.overrides) return false;
  if (LOCK_REQUIRED.includes(m.field)) {
    if (m.spec === ALIAS_SPEC) {
      // the alias key `myvite` has no copy under a member or a folder between,
      // so it resolves at the top level, and needs only its entry there
      if (!model.hoisted) return false;
    } else {
      const r = memberViteVersion(model, m);
      if (r.at === 'between' || r.version === null) return false;
      if (plainRange(m.spec) && !inRange(r.version, m.spec)) return false;
    }
  }
  const first = model.members[0];
  if (m.dep !== 'none' && memberNameOf(first) !== null) {
    // linked to the first member: proven, version equal to its folder entry, range admits it
    if (!f.proven[0]) return false;
    if (memberVersion(model, 0) !== '1.0.0') return false;
    if (!inRange(memberVersion(model, 0), depSpec(m.dep))) return false;
  }
  if (m.ms && m.ms !== 'listed') return false;
  return true;
}

function rootLocked(model: Model, f: Facts): boolean {
  if (model.lock !== 'v3' && model.lock !== 'v2') return false;
  void f;
  if (model.hoisted === null) return false;
  return !plainRange(model.rootSpec) || inRange(model.hoisted, model.rootSpec);
}

const rootNarrow = (model: Model, f: Facts) =>
  f.membersProven && (model.rootField === 'dependencies' || model.rootField === 'devDependencies') && model.hoisted !== null && semver.valid(model.hoisted) !== null && inRange(model.hoisted, model.rootSpec);

function memberNarrow(model: Model, f: Facts, i: number): boolean {
  const m = model.members[i];
  if (!f.membersProven || !f.proven[i]) return false;
  if (m.field !== 'dependencies' && m.field !== 'devDependencies') return false;
  if (m.spec === ALIAS_SPEC || !plainRange(m.spec)) return false;
  const r = memberViteVersion(model, m);
  return r.at === 'top' && r.version !== null && inRange(r.version, m.spec);
}

const declaresVite = (m: ModelMember) => m.field !== 'none';
const appNarrow = (model: Model) => model.app !== undefined && inRange(model.app.version, model.app.spec);

function installedVite(model: Model): Set<string> {
  const out = new Set<string>();
  if (model.lock !== 'none') {
    if (model.hoisted) out.add(model.hoisted);
    if (model.transitive) out.add(model.transitive);
    if (model.between) out.add(model.between);
    for (const m of model.members) if (m.ownCopy) out.add(m.ownCopy);
  }
  if (model.nonMember) out.add('7.3.7');
  if (model.app) out.add(model.app.version);
  return out;
}

function dropOracle(model: Model, version: string): boolean {
  if (model.truncated || model.foreign || model.npmrc) return false;
  // every lockfile the scan reads must be readable and of version 2 or 3
  if (model.lock === 'v1' || model.lock === 'malformed' || model.lock === 'error') return false;
  const f = facts(model);
  // every manifest locked: the root, every member, no non-member, the app
  if (!rootLocked(model, f)) return false;
  if (!model.members.every((_, i) => memberLocked(model, f, i))) return false;
  if (model.nonMember) return false;
  if (model.app && !appNarrow(model)) return false;
  // every declarer of vite narrow
  if (!rootNarrow(model, f)) return false;
  if (!model.members.every((m, i) => !declaresVite(m) || memberNarrow(model, f, i))) return false;
  return !installedVite(model).has(version);
}

function oracleAdditions(model: Model): Set<string> {
  const out = new Set<string>();
  if (model.truncated || model.foreign) return out;
  const f = facts(model);
  if (rootNarrow(model, f) && (model.lock === 'v3' || model.lock === 'v2')) out.add(model.hoisted!);
  model.members.forEach((m, i) => {
    if (declaresVite(m) && memberNarrow(model, f, i)) out.add(memberViteVersion(model, m).version!);
  });
  if (model.app && appNarrow(model)) out.add(model.app.version);
  return out;
}

// Blinders: the same model with one dimension made harmless, so a kept floor
// that only this dimension keeps is counted (non-vacuity).
type Blinder =
  | 'lockKind'
  | 'recorded'
  | 'shape'
  | 'link'
  | 'folderEntry'
  | 'name'
  | 'stray'
  | 'nonMember'
  | 'ownCopy'
  | 'between'
  | 'field'
  | 'alias'
  | 'overrides'
  | 'memberDep'
  | 'versionMismatch'
  | 'rootField'
  | 'unsafe';
const BLINDERS: Blinder[] = ['lockKind', 'recorded', 'shape', 'link', 'folderEntry', 'name', 'stray', 'nonMember', 'ownCopy', 'between', 'field', 'alias', 'overrides', 'memberDep', 'versionMismatch', 'rootField', 'unsafe'];
function blind(model: Model, what: Blinder): Model {
  const m: Model = JSON.parse(JSON.stringify(model));
  if (what === 'lockKind' && m.lock !== 'none') m.lock = 'v3';
  if (what === 'recorded') m.recorded = 'same';
  if (what === 'shape') m.shape = 'array';
  if (what === 'stray') m.stray = 'none';
  if (what === 'nonMember') m.nonMember = false;
  if (what === 'between') m.between = null;
  if (what === 'versionMismatch') m.firstVersionMismatch = false;
  if (what === 'rootField') m.rootField = 'devDependencies';
  if (what === 'unsafe') m.unsafe = 'none';
  m.members.forEach((x, i) => {
    if (what === 'link') x.link = 'exact';
    if (what === 'folderEntry') x.folderEntry = true;
    if (what === 'name') {
      x.nameKind = 'ok';
      x.name = `m${i + 1}`;
    }
    if (what === 'ownCopy') delete x.ownCopy;
    if (what === 'field' && x.field !== 'none') x.field = 'dependencies';
    if (what === 'alias' && x.spec === ALIAS_SPEC) x.spec = '^7.0.0';
    if (what === 'overrides') x.overrides = false;
    if (what === 'memberDep' && x.dep === 'outOfRange') x.dep = 'inRange';
  });
  return m;
}

// ---- the tests ---------------------------------------------------------------

const CASES = 20000;
const SEED = 20261027;

describe('narrow override in workspaces: properties (seeded, generated repositories)', () => {
  it(`holds for ${CASES} generated workspace repositories`, async () => {
    const rand = mulberry32(SEED);
    let drops = 0;
    let kept = 0;
    let additionsSeen = 0;
    let goalShape = 0;
    const soleBlocker = Object.fromEntries(BLINDERS.map((b) => [b, 0])) as Record<Blinder, number>;
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
      const vite = (qs: string[]) => qs.filter((q) => q.startsWith('vite@')).map((q) => q.slice(5));

      // W1
      for (const q of dropped) if (!q.startsWith('vite@')) fail(`W1 non-vite drop ${q}`);
      const others = (qs: string[]) => qs.filter((q) => !q.startsWith('vite@')).join(',');
      if (others(base) !== others(head)) fail('W1 a name other than vite changed');

      // W5
      if ((model.truncated || model.foreign) && JSON.stringify(base) !== JSON.stringify(head)) fail('W5 head differs from base');

      // W2 + W3
      for (const v of vite(base)) {
        const oracle = dropOracle(model, v);
        const wasDropped = dropped.includes(`vite@${v}`);
        if (wasDropped && !oracle) fail(`W2 dropped vite@${v} but the oracle does not allow it`);
        if (!wasDropped && oracle) fail(`W3 kept vite@${v} although the oracle allows the drop`);
        if (wasDropped) drops++;
        else {
          kept++;
          for (const b of BLINDERS) if (dropOracle(blind(model, b), v)) soleBlocker[b]++;
        }
      }
      if (dropped.length > 0 && model.rootDir === '' && model.members.length >= 2) goalShape++;

      // W4
      const adds = oracleAdditions(model);
      additionsSeen += adds.size;
      const expected = [...new Set([...vite(base).filter((v) => !dropped.includes(`vite@${v}`)), ...adds])].sort();
      const actual = vite(head).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(`W4 head vite set ${actual} != expected ${expected}`);
    }

    if (process.env.WS_PROP_DEBUG) console.log(JSON.stringify({ drops, kept, additionsSeen, goalShape, soleBlocker }));
    expect(failures.slice(0, 3).join('\n\n')).toBe('');
    expect(failures).toEqual([]);
    expect(drops, 'drops').toBeGreaterThan(300);
    expect(kept, 'kept floors').toBeGreaterThan(300);
    expect(additionsSeen, 'additions').toBeGreaterThan(300);
    expect(goalShape, 'drops in a root workspace with two or more members').toBeGreaterThan(100);
    for (const b of BLINDERS) expect(soleBlocker[b], `dimension ${b} is never the sole blocker`).toBeGreaterThan(5);
  }, 240_000);
});

// The dependency-age row for vite: the floor strip of the lowest declared
// plain range (dependencies and devDependencies; an alias declares its
// target's range), raised to the lowest narrow addition only when no manifest
// declares vite in optionalDependencies, peerDependencies or
// bundleDependencies, the oracle's drop rule holds for the floor, and that
// lowest addition is not below the floor.
const stripSpec = (spec: string) => spec.replace(/^[^0-9]*/, '');
function lowestPlainSpec(model: Model): string | null {
  const specs: string[] = [];
  if (model.rootField === 'dependencies' || model.rootField === 'devDependencies') specs.push(model.rootSpec);
  for (const m of model.members) {
    if (m.field !== 'dependencies' && m.field !== 'devDependencies') continue;
    specs.push(m.spec === ALIAS_SPEC ? '^7.0.0' : m.spec);
  }
  if (model.nonMember) specs.push('^7.0.0');
  if (model.app) specs.push(model.app.spec);
  let best: string | null = null;
  for (const spec of specs) {
    if (!plainRange(spec)) continue;
    if (best === null || semver.lt(semver.minVersion(spec)!, semver.minVersion(best)!)) best = spec;
  }
  return best;
}
const declaredOutside = (model: Model) =>
  model.rootField === 'optionalDependencies' ||
  model.rootField === 'peerDependencies' ||
  model.members.some((m) => m.field === 'optionalDependencies' || m.field === 'peerDependencies' || m.field === 'bundleDependencies');

// The row's reading of a member's `overrides`: npm applies the workspace root's
// only, so a member's `overrides` never make it not locked (the drop rule's
// `memberLocked` says the opposite). Nothing else about the member changes.
const memberLockedForRow = (model: Model, f: Facts, i: number): boolean =>
  memberLocked({ ...model, members: model.members.map((m) => ({ ...m, overrides: false })) }, f, i);

// `dropOracle` with the row's reading of member `overrides`.
function dropOracleForRow(model: Model, version: string): boolean {
  if (model.truncated || model.foreign || model.npmrc) return false;
  if (model.lock === 'v1' || model.lock === 'malformed' || model.lock === 'error') return false;
  const f = facts(model);
  if (!rootLocked(model, f)) return false;
  if (!model.members.every((_, i) => memberLockedForRow(model, f, i))) return false;
  if (model.nonMember) return false;
  if (model.app && !appNarrow(model)) return false;
  if (!rootNarrow(model, f)) return false;
  if (!model.members.every((m, i) => !declaresVite(m) || memberNarrow(model, f, i))) return false;
  return !installedVite(model).has(version);
}

function oracleRow(model: Model): string | null {
  const spec = lowestPlainSpec(model);
  if (spec === null) return null;
  const floor = stripSpec(spec);
  if (declaredOutside(model) || !dropOracleForRow(model, floor)) return floor;
  const adds = [...oracleAdditions(model)].sort(semver.compare);
  if (adds.length === 0 || semver.lt(adds[0], floor)) return floor;
  return adds[0];
}

describe('narrow override in workspaces: the dependency-age row (seeded, generated repositories)', () => {
  it(`holds for ${CASES} generated workspace repositories`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '99.0.0' },
          time: new Proxy({}, { get: (_t, k) => (typeof k === 'string' && /^\d/.test(k) ? '2026-01-01T00:00:00Z' : undefined) }),
        }),
      })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rowOf = async (scenario: Scenario): Promise<string | null> => {
      loadRepo(scenario);
      const result = await analyzeDepAge('t', 'o', 'r', 'main');
      return result.dependencies.find((d) => d.name === 'vite')?.installedVersion ?? null;
    };
    try {
      const rand = mulberry32(SEED);
      let raised = 0;
      let compared = 0;
      const failures: string[] = [];
      for (let i = 0; i < CASES; i++) {
        const model = generate(rand);
        const scenario = toScenario(model);
        STRIP_TREE_FACTS = true;
        const base = await rowOf(scenario);
        STRIP_TREE_FACTS = false;
        const head = await rowOf(scenario);
        const note = `case ${i}: ${JSON.stringify(model)}\n  base=${base} head=${head}`;
        const fail = (msg: string) => failures.push(`${msg}\n${note}`);
        const want = oracleRow(model);
        if (want === null || base === null || head === null || model.truncated) continue;
        compared++;
        const comparable = semver.valid(base) !== null && semver.valid(head) !== null;
        if (comparable ? semver.lt(head, base) : head !== base) fail(`W6 row ${head} is below the base row ${base}`);
        if (head !== want) fail(`W6 row ${head} != oracle row ${want}`);
        if (head !== base) raised++;
      }
      if (process.env.WS_PROP_DEBUG) console.log(JSON.stringify({ raised, compared }));
      expect(failures.slice(0, 3).join('\n\n')).toBe('');
      expect(failures).toEqual([]);
      expect(compared).toBeGreaterThan(CASES / 2);
      expect(raised, 'raised rows').toBeGreaterThan(200);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 240_000);
});
