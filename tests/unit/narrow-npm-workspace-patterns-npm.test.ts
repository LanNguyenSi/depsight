/**
 * Differential tests of the `workspaces` pattern matcher of the npm workspace
 * proof (`matchWorkspacePatterns` in lib/manifest-discovery.ts, task 15162e9f)
 * against npm itself: `@npmcli/map-workspaces` from the npm on PATH, the code
 * npm runs to list a root's workspaces, on a real folder tree in a temp dir.
 * No network is needed. The npm install is found through `npm root -g`; when
 * it cannot be found (no npm on PATH) the tests are skipped.
 *
 * The matcher may count more folders as matched than npm does (that only
 * keeps a proof the root lockfile already gives), never fewer. On the
 * lower-case tree below, where the platforms agree, every list the matcher
 * supports must give exactly npm's answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { matchWorkspacePatterns } from '@/lib/manifest-discovery';

type MapWorkspaces = (opts: { cwd: string; pkg: { workspaces: unknown } }) => Promise<Map<string, string>>;

function loadMapWorkspaces(): MapWorkspaces | null {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 30_000 }).trim();
    const dir = join(root, 'npm', 'node_modules', '@npmcli', 'map-workspaces');
    if (!existsSync(dir)) return null;
    return createRequire(import.meta.url)(dir) as MapWorkspaces;
  } catch {
    return null;
  }
}

const mapWorkspaces = loadMapWorkspaces();

// Every folder holds a package.json with a name of its own (npm refuses two
// workspaces of one name).
const FOLDERS = [
  'a',
  'b',
  'packages',
  'packages/a',
  'packages/b',
  'packages/ab',
  'packages/b/inner',
  'packages/group/a',
  'packages/group/c/d',
  'packages/.hidden',
  'packages/.hidden/x',
  '.dot/x',
  'apps/web',
  'apps/web/sub',
  'tools/t',
  'x-y/z.z',
  'packages/@s/a',
];

// A small deterministic PRNG (mulberry32), so a failure replays.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['packages', 'apps', 'a', 'b', 'ab', 'group', 'inner', 'web', 'c', 'd', 'sub', 'tools', 't', 'x-y', 'z.z', '@s', '.hidden', '.dot', 'x', '*', '*', '**', '**', 'a*', '*b', '.*', '*.*', 'x-*', '***', 'a**', 'p*s', '*a*'];
const UNSUPPORTED = ['{a,b}', '?', '[ab]', 'a\\b', '#x', '..', '.', '', '+(a)', '@(a)', '!(a)', 'a b'];

// A pattern of random segments, or one made from a folder of the tree with
// some segments replaced by wildcards (so that many lists match something).
function randomPattern(rand: () => number, allowUnsupported: boolean): string {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  let parts: string[];
  if (rand() < 0.5) {
    parts = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(SEGMENTS));
  } else {
    parts = pick(FOLDERS)
      .split('/')
      .map((segment) => (rand() < 0.35 ? pick(['*', '**', `${segment[0]}*`, `*${segment.slice(-1)}`]) : segment));
    if (rand() < 0.2) parts.push(pick(['*', '**']));
  }
  if (allowUnsupported && rand() < 0.08) parts[Math.floor(rand() * parts.length)] = pick(UNSUPPORTED);
  const bangs = rand() < 0.6 ? 0 : pick([1, 1, 1, 2, 3]);
  const prefix = pick(['', '', '', '', './', '/', './/']);
  const trailing = rand() < 0.2 ? '/' : '';
  return `${'!'.repeat(bangs)}${prefix}${parts.join('/')}${trailing}`;
}

describe.skipIf(mapWorkspaces === null)('matchWorkspacePatterns against npm (@npmcli/map-workspaces)', () => {
  // The tree sits two empty folders deep, so a `..` pattern (which npm walks
  // out of the root with) finds nothing but these folders.
  let base = '';
  let root = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'depsight-ws-patterns-'));
    root = join(base, 'up', 'tree');
    FOLDERS.forEach((folder, i) => {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, 'package.json'), JSON.stringify({ name: `p${i}`, version: '1.0.0' }));
    });
  });
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const npmMatches = async (workspaces: string[]): Promise<Set<string>> => {
    const map = await (mapWorkspaces as MapWorkspaces)({ cwd: root, pkg: { workspaces } });
    return new Set([...map.values()].map((path) => relative(root, path).split('\\').join('/')));
  };

  // npm's answer, or the error code when npm refuses the list (then npm
  // installs nothing, and there is no answer to compare with).
  const compare = async (workspaces: string[]) => {
    const got = matchWorkspacePatterns(workspaces, FOLDERS);
    try {
      return { want: await npmMatches(workspaces), got, refused: null };
    } catch (err) {
      return { want: new Set<string>(), got, refused: String((err as Error).message) };
    }
  };

  it('agrees with npm on the documented shapes', async () => {
    const shapes: string[][] = [
      ['packages/*'],
      ['packages/**'],
      ['**'],
      ['*'],
      ['packages/*/'],
      ['./packages/*'],
      ['/packages/*'],
      ['packages/a', 'tools/t'],
      ['packages/*', '!packages/b'],
      ['packages/*', '!packages/b/'],
      ['packages/**', '!packages/b/**'],
      ['packages/**', '!packages/b/**', 'packages/b/inner'],
      ['packages/**', '!packages/group'],
      ['packages/**', '!packages/*'],
      ['!packages/b', 'packages/*'],
      ['packages/*', '!!packages/b'],
      ['packages/*', '!!!packages/b'],
      ['packages/*', '!packages/*', 'packages/a'],
      ['packages/*', '!packages/a', 'packages/*'],
      ['packages/.*'],
      ['packages/*', '!packages/*', 'packages/.hidden'],
      ['packages/**', '!packages/.hidden'],
      ['.dot/*'],
      ['**/x'],
      ['packages/a**'],
      ['packages/***'],
      ['packages/@s/*'],
      ['x-*/*.*'],
      ['packages/*', '!packages/b/', 'packages/b'],
      ['packages/*', '!packages/b', 'packages/b/'],
      ['packages/', '!packages/*'],
      ['!packages/**', 'packages'],
      ['packages', '!packages/**'],
      ['packages/**/**/a'],
      ['**/**'],
      ['packages/**/', '!packages/**/**'],
      ['!packages/**', 'packages/.hidden'],
    ];
    for (const workspaces of shapes) {
      const { want, got } = await compare(workspaces);
      expect(got === 'unsupported' || got === null ? got : [...got].sort(), JSON.stringify(workspaces)).toEqual([...want].sort());
    }
  });

  it('agrees with npm on random pattern lists it supports', async () => {
    const rand = prng(15162);
    let supported = 0;
    let unsupported = 0;
    let nonEmpty = 0;
    const mismatches: string[] = [];
    const refusedButRead: string[] = [];
    for (let round = 0; round < 3000; round++) {
      const workspaces = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => randomPattern(rand, true));
      const { want, got, refused } = await compare(workspaces);
      expect(got, JSON.stringify(workspaces)).not.toBeNull();
      // a list npm refuses is never one the matcher claims to read
      if (refused !== null) {
        if (got !== 'unsupported') refusedButRead.push(`${JSON.stringify(workspaces)}: ${refused}`);
        continue;
      }
      if (got === 'unsupported') {
        unsupported++;
        continue;
      }
      supported++;
      if (want.size > 0) nonEmpty++;
      const gotList = JSON.stringify([...(got as Set<string>)].sort());
      const wantList = JSON.stringify([...want].sort());
      if (gotList !== wantList) mismatches.push(`${JSON.stringify(workspaces)} got ${gotList} want ${wantList}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(refusedButRead).toEqual([]);
    // non-vacuous: most lists are supported, many match something, some are not supported
    expect(supported).toBeGreaterThan(2000);
    expect(nonEmpty).toBeGreaterThan(1000);
    expect(unsupported).toBeGreaterThan(20);
  }, 120_000);

  it('never matches fewer folders than npm when the patterns differ in case from the folders', async () => {
    // npm on macOS and Windows matches a pattern case-insensitively and its
    // negations too, npm on Linux neither: reading the patterns
    // case-insensitively and the negations case-sensitively matches at least
    // what npm matches on either
    const rand = prng(20261102);
    let compared = 0;
    const fewer: string[] = [];
    for (let round = 0; round < 1500; round++) {
      const workspaces = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
        [...randomPattern(rand, false)].map((c) => (rand() < 0.3 ? c.toUpperCase() : c)).join(''),
      );
      const { want, got, refused } = await compare(workspaces);
      if (refused !== null || got === 'unsupported' || got === null) continue;
      compared++;
      // on a case-insensitive file system glob reports a literal segment in
      // the pattern's case (`B` for the folder `b`); the tree is lower case
      const missing = [...want].map((f) => f.toLowerCase()).filter((f) => !got.has(f));
      if (missing.length > 0) fewer.push(`${JSON.stringify(workspaces)} misses ${JSON.stringify(missing)}`);
    }
    expect(fewer.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(1000);
  }, 120_000);

  it('the shapes it does not support, where npm reads them in a way the matcher does not model', async () => {
    // glob finds packages/.hidden for `**/.*`, then npm drops it (minimatch's
    // partial mode); the plain reading would keep it
    const dotAfterGlobstar = await compare(['**/.*']);
    expect(dotAfterGlobstar.got).toBe('unsupported');
    expect(dotAfterGlobstar.want.has('packages/.hidden')).toBe(false);
    // npm drops the first `!packages/a`, steps past the second, and so keeps
    // excluding packages/a although `packages/a` comes after both
    const skipped = await compare(['packages/*', '!packages/a', '!packages/a', 'packages/a']);
    expect(skipped.got).toBe('unsupported');
    expect(skipped.want.has('packages/a')).toBe(false);
    expect(skipped.want.has('packages/b')).toBe(true);
  });
});
