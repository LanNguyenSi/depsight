/**
 * Oracle for the npm workspace proof (`provenWorkspaceFolders` in
 * lib/manifest-discovery.ts, task 15162e9f): real npm writes the root
 * package-lock.json (`npm install --package-lock-only --offline`) for a set of
 * workspace shapes in a temp dir, and npm's own list of the root's workspaces
 * (`npm query .workspace --package-lock-only`) is the ground truth. Some shapes
 * are written twice, the second time after the patterns or a spec changed, as
 * a repository's history would leave them.
 *
 * For every shape: no folder the scan proves is a folder npm does not count as
 * a workspace (no false member proof), and every workspace that the root
 * lockfile links is proven (no genuine member loses its proof to the
 * patterns). The shapes marked `residual` are the ones where npm keeps the link
 * of a folder that is no workspace any more; before the patterns were read,
 * the scan proved that folder.
 *
 * Opt-in, because it runs npm about 30 times (several seconds): set
 * DEPSIGHT_NPM_ORACLE=1. No network is needed (`--offline`, no registry
 * dependency, scoped package names no registry holds); the npm on PATH is used,
 * with an empty user config and a cache in the temp dir. Every npm run has a
 * timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { provenWorkspaceFolders } from '@/lib/manifest-discovery';

const ENABLED = process.env.DEPSIGHT_NPM_ORACLE === '1';
const NPM_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;
// One state of the repository: package.json files by folder ('' is the root).
type State = Record<string, Json>;

interface Shape {
  name: string;
  states: State[];
  // npm keeps the link of a folder that is no workspace in the final lockfile
  residual?: boolean;
}

const n = (short: string) => `@depsight-oracle/${short}`;
const member = (short: string, deps: Record<string, string> = {}): Json => ({ name: n(short), version: '1.0.0', dependencies: deps });
const root = (workspaces: unknown, deps: Record<string, string> = {}): Json => ({ name: 'oracle-root', version: '1.0.0', workspaces, dependencies: deps });

const SHAPES: Shape[] = [
  {
    name: 'plain glob, a folder outside the patterns',
    states: [{ '': root(['packages/*']), 'packages/a': member('a'), 'packages/b': member('b'), 'tools/t': member('t') }],
  },
  {
    name: 'nested **',
    states: [{ '': root(['packages/**']), 'packages/a': member('a'), 'packages/group/c': member('c'), 'packages/group/d/e': member('e') }],
  },
  {
    name: 'negation',
    states: [{ '': root(['packages/*', '!packages/b']), 'packages/a': member('a'), 'packages/b': member('b') }],
  },
  {
    name: 'negation, then a later pattern includes a folder again',
    states: [{ '': root(['packages/**', '!packages/x/**', 'packages/x/y']), 'packages/a': member('a'), 'packages/x/z': member('z'), 'packages/x/y': member('y') }],
  },
  {
    name: 'literal paths, a ./ prefix and a trailing slash',
    states: [{ '': root(['packages/a', './tools/t/']), 'packages/a': member('a'), 'packages/b': member('b'), 'tools/t': member('t') }],
  },
  {
    name: 'object form',
    states: [{ '': root({ packages: ['packages/*'] }), 'packages/a': member('a'), 'tools/t': member('t') }],
  },
  {
    name: 'inter-dependent genuine members',
    states: [{ '': root(['packages/*']), 'packages/a': member('a', { [n('b')]: '^1.0.0' }), 'packages/b': member('b', { [n('a')]: '^1.0.0' }) }],
  },
  {
    name: 'pattern shrink, a member still depends on the leaver',
    residual: true,
    states: [
      { '': root(['packages/*', 'tools/*']), 'packages/a': member('a', { [n('t')]: '^1.0.0' }), 'tools/t': member('t') },
      { '': root(['packages/*']), 'packages/a': member('a', { [n('t')]: '^1.0.0' }), 'tools/t': member('t') },
    ],
  },
  {
    name: 'a ** pattern narrowed to *, a member still depends on the leaver',
    residual: true,
    states: [
      { '': root(['packages/**']), 'packages/a': member('a', { [n('x')]: '^1.0.0' }), 'packages/old/x': member('x') },
      { '': root(['packages/*']), 'packages/a': member('a', { [n('x')]: '^1.0.0' }), 'packages/old/x': member('x') },
    ],
  },
  {
    name: 'negation added, a member still depends on the excluded folder',
    residual: true,
    states: [
      { '': root(['packages/*']), 'packages/a': member('a', { [n('b')]: '^1.0.0' }), 'packages/b': member('b') },
      { '': root(['packages/*', '!packages/b']), 'packages/a': member('a', { [n('b')]: '^1.0.0' }), 'packages/b': member('b') },
    ],
  },
  {
    name: 'a file: dependency became a registry range',
    residual: true,
    states: [
      { '': root(['packages/*'], { [n('t')]: 'file:tools/t' }), 'packages/a': member('a'), 'tools/t': member('t') },
      { '': root(['packages/*'], { [n('t')]: '^1.0.0' }), 'packages/a': member('a'), 'tools/t': member('t') },
    ],
  },
  {
    name: 'pattern shrink, the leaver is a member of an inter-dependent pair',
    residual: true,
    states: [
      { '': root(['packages/*', 'tools/*']), 'packages/a': member('a', { [n('t')]: '^1.0.0' }), 'tools/t': member('t', { [n('a')]: '^1.0.0' }) },
      { '': root(['packages/*']), 'packages/a': member('a', { [n('t')]: '^1.0.0' }), 'tools/t': member('t', { [n('a')]: '^1.0.0' }) },
    ],
  },
];

function runNpm(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const r = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: NPM_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (r.error || r.status !== 0) throw new Error(`npm ${args.join(' ')} in ${cwd}: ${r.error?.message ?? `exit ${r.status}`}\n${r.stderr}`);
  return r.stdout;
}

// The folders the lockfile links as the scan reads a link (an entry for the
// folder that is no link, and `node_modules/<its name>` a link resolving to
// exactly it), worked out here without the code under test.
function linkedFolders(lock: Json, state: State): Set<string> {
  const packages = (lock.packages ?? {}) as Record<string, Json>;
  const out = new Set<string>();
  for (const [folder, manifest] of Object.entries(state)) {
    if (folder === '') continue;
    const entry = packages[folder];
    const link = packages[`node_modules/${String(manifest.name)}`];
    if (entry && entry.link === undefined && link && link.link === true && link.resolved === folder) out.add(folder);
  }
  return out;
}

describe.skipIf(!ENABLED)('npm workspace proof against real npm (DEPSIGHT_NPM_ORACLE=1)', () => {
  let base = '';
  let env: NodeJS.ProcessEnv = {};
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'depsight-npm-oracle-'));
    writeFileSync(join(base, 'empty-npmrc'), '');
    env = {
      ...process.env,
      npm_config_userconfig: join(base, 'empty-npmrc'),
      npm_config_cache: join(base, 'cache'),
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_ignore_scripts: 'true',
    };
  });
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('records the npm version the oracle ran with', () => {
    expect(runNpm(base, env, ['--version']).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  for (const [i, shape] of SHAPES.entries()) {
    it(`${shape.name}: no false member proof, no genuine linked member unproven`, () => {
      const dir = join(base, `shape-${i}`);
      let state: State = {};
      for (const next of shape.states) {
        for (const folder of Object.keys(state)) if (!(folder in next)) rmSync(join(dir, folder, 'package.json'));
        for (const [folder, manifest] of Object.entries(next)) {
          const file = join(dir, folder, 'package.json');
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(manifest, null, 2));
        }
        state = next;
        runNpm(dir, env, ['install', '--package-lock-only']);
      }
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as Json;
      const truth = new Set(
        (JSON.parse(runNpm(dir, env, ['query', '.workspace', '--package-lock-only'])) as Array<{ location: string }>).map((w) => w.location),
      );
      const candidates = Object.entries(state)
        .filter(([folder]) => folder !== '')
        .map(([folder, manifest]) => ({ folder, name: manifest.name }));
      const proven = provenWorkspaceFolders(state[''].workspaces, lock, candidates);
      const linked = linkedFolders(lock, state);

      expect(proven, 'the lockfile proves membership at all').not.toBeNull();
      const falseProofs = [...(proven as Set<string>)].filter((f) => !truth.has(f));
      const lostProofs = [...linked].filter((f) => truth.has(f) && !(proven as Set<string>).has(f));
      expect(falseProofs).toEqual([]);
      expect(lostProofs).toEqual([]);
      // non-vacuous: npm lists members, and the residual shapes do keep a link
      // to a folder that is no workspace (which the lockfile alone proves)
      expect(truth.size).toBeGreaterThan(0);
      expect([...linked].some((f) => !truth.has(f)), 'npm kept the link of a folder that is no workspace').toBe(shape.residual === true);
    }, 4 * NPM_TIMEOUT_MS);
  }
});
