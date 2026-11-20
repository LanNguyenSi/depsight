/**
 * PHP resolution: the version a composer constraint is read as, how a raw
 * composer.lock response is decoded, and which composer.lock files are read.
 * `collectPhpDepsResolved` runs for real against a fake GitHub client that
 * counts every `getContent` call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Octokit } from '@/lib/manifest-discovery';
import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { collectPhpDepsResolved, composerConstraintFloor } from '@/lib/manifests/php';

describe('composerConstraintFloor', () => {
  const cases: Array<[string, string]> = [
    // documented cases
    ['^1.2.3', '1.2.3'],
    ['~2.0', '2.0'],
    ['>=1.0', '1.0'],
    ['>= 1.0', '1.0'],
    ['1.0.0', '1.0.0'],
    ['6.4.*', '6.4.0'],
    ['2.x', '2.0'],
    ['^5.4|^6.0', '5.4'],
    ['^5.4 || ^6.0', '5.4'],
    ['>=1.0 <2.0', '1.0'],
    ['>=1.0,<2.0', '1.0'],
    ['^1.0@dev', '1.0'],
    ['2.5.0 as 2.0.0', '2.5.0'],
    ['*', ''],
    ['dev-main', ''],
    ['dev-main as 1.0', ''],
    ['1.0.x-dev', ''],
    ['', ''],
    // a first term without a lower bound gives no floor
    ['<2.0', ''],
    ['<=2.0', ''],
    ['<= 2.0', ''],
    ['!=2.0', ''],
    ['!= 2.0', ''],
    ['<2.0 >=1.0', ''],
    ['!=1.0 || ^2.0', ''],
    // the first term decides, an upper bound later does not
    ['>=1.0 !=1.5', '1.0'],
    // a -dev suffix after a lower-bound operator is stability, not a branch
    ['^1.2-dev', '1.2'],
    ['~1.2-dev', '1.2'],
    ['>=1.2-dev', '1.2'],
    ['>1.2-dev', '1.2'],
    ['^1.2.3-dev', '1.2.3'],
    ['^1.2-DEV', '1.2'],
    // a -dev branch alias is not a release
    ['1.2-dev', ''],
    ['=1.2-dev', ''],
    ['==1.2-dev', ''],
    ['^1.x-dev', ''],
    ['~1.2.x-dev', ''],
    ['^1.*-dev', ''],
    ['dev-main-dev', ''],
  ];
  it.each(cases)('%j reads as %j', (constraint, floor) => {
    expect(composerConstraintFloor(constraint)).toBe(floor);
  });
});

// The scan test below reads the repository through this client: a git tree over
// `scan.files` (optionally truncated) and a counting getContent.
const scan = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  truncated: false,
  calls: [] as Array<{ path: string; raw: boolean }>,
}));
vi.mock('@/lib/github', () => ({
  createGitHubClient: () => ({
    rest: {
      git: {
        getTree: async () => ({
          data: {
            truncated: scan.truncated,
            tree: Object.keys(scan.files).map((path) => ({ path, type: 'blob' })),
          },
        }),
      },
      repos: {
        getContent: async ({ path, mediaType }: { path: string; mediaType?: { format?: string } }) => {
          const raw = mediaType?.format === 'raw';
          scan.calls.push({ path, raw });
          if (!(path in scan.files)) throw Object.assign(new Error('nf'), { status: 404 });
          if (raw) return { data: scan.files[path] };
          return { data: { content: Buffer.from(scan.files[path]).toString('base64') } };
        },
        get: async () => ({ data: { default_branch: 'main' } }),
      },
    },
  }),
}));

type Sent = { path: string; raw: boolean };

/** A fake GitHub client over `files`; records every getContent call. */
function fakeOctokit(files: Record<string, string>, rawAs: (text: string) => unknown = (t) => t) {
  const calls: Sent[] = [];
  const octokit = {
    rest: {
      repos: {
        getContent: vi.fn(async ({ path, mediaType }: { path: string; mediaType?: { format?: string } }) => {
          const raw = mediaType?.format === 'raw';
          calls.push({ path, raw });
          if (!(path in files)) throw Object.assign(new Error('nf'), { status: 404 });
          if (raw) return { data: rawAs(files[path]) };
          return { data: { content: Buffer.from(files[path]).toString('base64') } };
        }),
      },
    },
  };
  return { octokit: octokit as unknown as Octokit, calls };
}

const composerJson = (require: Record<string, string>) => JSON.stringify({ require });
const lock = (pkgs: Record<string, string>) =>
  JSON.stringify({ packages: Object.entries(pkgs).map(([name, version]) => ({ name, version })) });
const lockCalls = (calls: Sent[]) => calls.filter((c) => c.raw).map((c) => c.path);

describe('composer.lock raw response decoding', () => {
  const files = {
    'composer.json': composerJson({ 'acme/lib': '^1.0' }),
    // a multi-byte character must survive the decoding
    'composer.lock': lock({ 'acme/lib': '1.4.2', 'acme/café': '2.0.0' }),
  };
  const asBytes = (t: string) => new TextEncoder().encode(t);
  const asBuffer = (t: string) => asBytes(t).buffer.slice(0) as ArrayBuffer;

  const responses: Array<[string, (t: string) => unknown]> = [
    ['a string', (t) => t],
    ['an ArrayBuffer', asBuffer],
    ['a Uint8Array', asBytes],
    ['a Node Buffer', (t) => Buffer.from(t, 'utf-8')],
  ];
  it.each(responses)('reads the lock when GitHub answers with %s', async (_label, rawAs) => {
    const { octokit } = fakeOctokit(files, rawAs);
    const deps = await collectPhpDepsResolved(octokit, 'o', 'r', ['composer.json']);
    expect(deps).toEqual([
      { name: 'acme/lib', version: '1.4.2' },
      { name: 'acme/café', version: '2.0.0' },
    ]);
  });

  it('strips a UTF-8 byte order mark from a binary response', async () => {
    const withBom = (t: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...asBytes(t)]);
    const { octokit } = fakeOctokit(files, withBom);
    const deps = await collectPhpDepsResolved(octokit, 'o', 'r', ['composer.json']);
    expect(deps[0]).toEqual({ name: 'acme/lib', version: '1.4.2' });
  });

  it('skips a raw response that is neither text nor bytes (the floor stands)', async () => {
    const { octokit } = fakeOctokit(files, () => ({ unexpected: true }));
    const deps = await collectPhpDepsResolved(octokit, 'o', 'r', ['composer.json']);
    expect(deps).toEqual([{ name: 'acme/lib', version: '1.0' }]);
  });
});

describe('which composer.lock files are read', () => {
  const N = 4;
  const dirs = Array.from({ length: N }, (_, i) => `svc-${i}`);
  const manifestPaths = dirs.map((d) => `${d}/composer.json`);
  const files: Record<string, string> = {};
  for (const d of dirs) files[`${d}/composer.json`] = composerJson({ 'acme/lib': '^1.0' });
  // only two of the four have a lock
  files['svc-0/composer.lock'] = lock({ 'acme/lib': '1.1.0' });
  files['svc-2/composer.lock'] = lock({ 'acme/lib': '1.2.0' });

  it('reads exactly the observed locks: M of N composer.json', async () => {
    const { octokit, calls } = fakeOctokit(files);
    const deps = await collectPhpDepsResolved(octokit, 'o', 'r', manifestPaths, [
      'svc-0/composer.lock',
      'svc-2/composer.lock',
    ]);
    expect(lockCalls(calls).sort()).toEqual(['svc-0/composer.lock', 'svc-2/composer.lock']);
    // the N manifest reads are untouched
    expect(calls.filter((c) => !c.raw)).toHaveLength(N);
    expect(deps.map((d) => d.version).sort()).toEqual(['1.0', '1.1.0', '1.2.0']);
  });

  it('an observed set with no composer.lock at all reads no lock and queries the floors', async () => {
    const { octokit, calls } = fakeOctokit(files);
    const deps = await collectPhpDepsResolved(octokit, 'o', 'r', manifestPaths, []);
    expect(lockCalls(calls)).toEqual([]);
    expect(deps).toEqual([{ name: 'acme/lib', version: '1.0' }]);
  });

  it('a null observed set (truncated or fallback walk) probes the sibling of every composer.json: N calls', async () => {
    const { octokit, calls } = fakeOctokit(files);
    const deps = await collectPhpDepsResolved(octokit, 'o', 'r', manifestPaths, null);
    expect(lockCalls(calls).sort()).toEqual(dirs.map((d) => `${d}/composer.lock`));
    expect(deps.map((d) => d.version).sort()).toEqual(['1.0', '1.1.0', '1.2.0']);
  });

  it('an absent observed set behaves like null: N calls', async () => {
    const { octokit, calls } = fakeOctokit(files);
    await collectPhpDepsResolved(octokit, 'o', 'r', manifestPaths);
    expect(lockCalls(calls)).toHaveLength(N);
  });

  it('an observed lock beside no listed composer.json is not read', async () => {
    const { octokit, calls } = fakeOctokit(files);
    await collectPhpDepsResolved(octokit, 'o', 'r', manifestPaths, [
      'svc-0/composer.lock',
      'elsewhere/composer.lock',
    ]);
    expect(lockCalls(calls)).toEqual(['svc-0/composer.lock']);
  });

  it('matches observed paths case-insensitively, like the npm lockfile fetchers', async () => {
    const { octokit, calls } = fakeOctokit(files);
    await collectPhpDepsResolved(octokit, 'o', 'r', manifestPaths, ['SVC-0/Composer.lock']);
    expect(lockCalls(calls)).toEqual(['svc-0/composer.lock']);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OSV scan of a PHP repository: which composer.lock files are read', () => {
  const dirs = ['a', 'b', 'c'];
  const files: Record<string, string> = {};
  for (const d of dirs) files[`${d}/composer.json`] = composerJson({ 'acme/lib': '^1.0' });
  files['b/composer.lock'] = lock({ 'acme/lib': '1.9.0' });

  const run = async (truncated: boolean) => {
    scan.files = files;
    scan.truncated = truncated;
    scan.calls = [];
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init!.body!) as { queries: Array<{ package: { name: string }; version: string }> };
        for (const q of body.queries) queries.push(`${q.package.name}@${q.version}`);
        return { ok: true, json: async () => ({ results: body.queries.map(() => ({})) }) };
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fetchOsvAdvisories('t', 'o', 'r', 'main');
    } finally {
      warn.mockRestore();
    }
    return { queries, locks: lockCalls(scan.calls).sort() };
  };

  it('a complete tree walk reads only the composer.lock files it saw: 1 of 3', async () => {
    const { locks, queries } = await run(false);
    expect(locks).toEqual(['b/composer.lock']);
    expect(queries.sort()).toEqual(['acme/lib@1.0', 'acme/lib@1.9.0']);
  });

  it('a truncated walk keeps the blind probe: the sibling of every composer.json, 3 of 3', async () => {
    // the root-only fallback finds no manifest in this fixture, so the PHP
    // projects come from the truncated tree itself
    const { locks } = await run(true);
    expect(locks).toEqual(['a/composer.lock', 'b/composer.lock', 'c/composer.lock']);
  });
});
