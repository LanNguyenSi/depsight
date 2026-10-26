/**
 * The repo-wide npm chain also queries what a declarer can install when the
 * one version the chain holds for a name is not it.
 *
 *   range branch      a declarer with a plain semver range that the merged
 *                     lockfile `resolved` version does not satisfy: its floor
 *                     is queried as well
 *   non-range branch  a declarer with no range to compare (`latest`, a tag, a
 *                     git or `file:` spec, `*`): every version any lockfile
 *                     records for the name is queried
 *
 * Both only ever ADD to the chain the code produced before. The exact query
 * sets of the two shapes found by review run through the real pipeline in
 * osv-narrow-scenarios.test.ts (declarerRangeBelowRootLock and
 * latestDeclarerBesideLockedRange); this file pins the branches and the input
 * combinations one by one on `repoWideNpmEntries`, and checks additions-only
 * against a copy of the previous algorithm over seeded random inputs.
 */
import { describe, it, expect } from 'vitest';
import semver from 'semver';
import { repoWideNpmEntries } from '@/lib/cve/osv';
import {
  type LockfileResolutions,
  type ParsedNpmManifest,
  lockfileVersionsOf,
  mergeLockfileResolutions,
  npmDeclarations,
  parseNpmLockfileContentsList,
  parseYarnLockfileContentsList,
  unionNpmDeps,
} from '@/lib/manifest-discovery';

const EMPTY: LockfileResolutions = { resolved: new Map(), ambiguous: new Map() };

/** A package-lock.json (lockfileVersion 3): per name, its versions, the first top level. */
function npmLock(entries: Record<string, string[]>): LockfileResolutions {
  const packages: Record<string, { version: string }> = { '': {} as { version: string } };
  for (const [name, versions] of Object.entries(entries)) {
    versions.forEach((version, i) => {
      packages[i === 0 ? `node_modules/${name}` : `node_modules/host${i}/node_modules/${name}`] = { version };
    });
  }
  return parseNpmLockfileContentsList([JSON.stringify({ lockfileVersion: 3, packages })]);
}

/** A yarn.lock (v1): one block per name and version. */
function yarnLock(entries: Record<string, string[]>): LockfileResolutions {
  const blocks = Object.entries(entries).flatMap(([name, versions]) =>
    versions.map((version, i) => `${name}@^${i}.0.0:\n  version "${version}"\n`),
  );
  return parseYarnLockfileContentsList([`# yarn lockfile v1\n\n${blocks.join('\n')}`]);
}

const asPairs = (entries: Array<{ name: string; version: string }>) =>
  entries.map((e) => `${e.name}@${e.version}`).sort();

const deps = (d: Record<string, string>): ParsedNpmManifest => ({ dependencies: d });

describe('range branch: a declared plain range the resolved version does not satisfy', () => {
  it('queries the declarer floor next to the resolved version', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['vite@6.0.0', 'vite@8.3.5']);
  });

  it('adds nothing when the resolved version satisfies every declared range', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0' }), deps({ vite: '^8.0.0' })],
      npmLock({ vite: ['8.3.5'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['vite@8.3.5']);
  });

  it('adds the floor of a range that lies above the resolved version too', () => {
    const out = repoWideNpmEntries([deps({ vite: '^9.1.0' })], npmLock({ vite: ['8.3.5'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@8.3.5', 'vite@9.1.0']);
  });

  it('uses the lowest version of a compound range as its floor', () => {
    const out = repoWideNpmEntries([deps({ vite: '>=6.1.0 <7' })], npmLock({ vite: ['8.3.5'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@6.1.0', 'vite@8.3.5']);
  });

  it('adds the exact pin of a declarer whose pin differs from the resolution', () => {
    const out = repoWideNpmEntries([deps({ vite: '6.2.1' })], npmLock({ vite: ['8.3.5'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@6.2.1', 'vite@8.3.5']);
  });

  it('counts a prerelease resolution as not satisfying a stable range', () => {
    // 8.1.0-rc.1 lies inside ^8.0.0 numerically, but a prerelease only satisfies a
    // range that names a prerelease of the same version: query the floor too.
    const out = repoWideNpmEntries([deps({ vite: '^8.0.0' })], npmLock({ vite: ['8.1.0-rc.1'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@8.0.0', 'vite@8.1.0-rc.1']);
  });

  it('treats a resolution that is not a semver version as not satisfying', () => {
    const out = repoWideNpmEntries([deps({ vite: '^6.0.0' })], npmLock({ vite: ['1.2.3.4'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@1.2.3.4', 'vite@6.0.0']);
  });

  it('adds nothing for a range that admits no version at all (no floor to query)', () => {
    const out = repoWideNpmEntries([deps({ vite: '>2 <1' })], npmLock({ vite: ['8.3.5'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@8.3.5']);
  });

  it('reads devDependencies and an npm: alias as declarations of the real name', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0' }), { devDependencies: { vite: '^6.0.0' } }, deps({ bundler: 'npm:vite@~5.4.2' })],
      npmLock({ vite: ['8.3.5'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['vite@5.4.2', 'vite@6.0.0', 'vite@8.3.5']);
  });

  it('ignores a declaration of a name that is one of the local packages', () => {
    const out = repoWideNpmEntries(
      [{ name: 'vite', dependencies: { other: '1.0.0' } }, deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'], other: ['1.0.0'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['other@1.0.0']);
  });

  it('adds nothing for a name without a resolved version (floor or ambiguous answers it)', () => {
    // No lockfile at all: the lowest declared range is the chain answer.
    expect(
      asPairs(repoWideNpmEntries([deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })], EMPTY, EMPTY)),
    ).toEqual(['vite@6.0.0']);
    // Conflicting lockfile copies: the name is ambiguous, not resolved; the
    // chain keeps the floor of the lowest range and the range branch is silent.
    expect(
      asPairs(
        repoWideNpmEntries(
          [deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })],
          npmLock({ vite: ['8.3.5', '7.3.7'] }),
          EMPTY,
        ),
      ),
    ).toEqual(['vite@6.0.0']);
  });

  it('documented residual: an ambiguous or unresolved name queries only the lowest range floor', () => {
    const ranges = [deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })];
    // yarn.lock with two versions: root's installed 8.3.5 and the 7.3.7 copy stay unqueried.
    expect(asPairs(repoWideNpmEntries(ranges, EMPTY, yarnLock({ vite: ['8.3.5', '7.3.7'] })))).toEqual([
      'vite@6.0.0',
    ]);
    // No lockfile: the higher range's floor 8.3.0 stays unqueried.
    expect(asPairs(repoWideNpmEntries(ranges, EMPTY, EMPTY))).toEqual(['vite@6.0.0']);
  });

  it('uses the resolution both lockfile formats agree on, and nothing when they disagree', () => {
    const agree = repoWideNpmEntries(
      [deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['8.3.5'] }),
    );
    expect(asPairs(agree)).toEqual(['vite@6.0.0', 'vite@8.3.5']);
    const disagree = repoWideNpmEntries(
      [deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['8.4.0'] }),
    );
    // Disagreement leaves the name ambiguous: the chain answers with the floor 6.0.0.
    expect(asPairs(disagree)).toEqual(['vite@6.0.0']);
  });
});

describe('non-range branch: a declared spec with no range to compare', () => {
  const ambiguous = () => npmLock({ vite: ['8.3.5', '7.3.7', '6.2.1'] });

  it.each(['latest', 'beta', '*', 'x', '', 'github:acme/vite#main', 'file:../vite'])(
    'queries every lockfile version of the name beside the spec %j',
    (spec) => {
      const out = repoWideNpmEntries([deps({ vite: spec }), deps({ vite: '^8.3.0' })], ambiguous(), EMPTY);
      // The chain floor 8.3.0 stays; every lockfile copy joins it.
      expect(asPairs(out)).toEqual(['vite@6.2.1', 'vite@7.3.7', 'vite@8.3.0', 'vite@8.3.5']);
    },
  );

  it('queries every lockfile version when it is the only declaration', () => {
    const out = repoWideNpmEntries([deps({ vite: 'latest' })], ambiguous(), EMPTY);
    // The chain alone answered with the lowest copy, 6.2.1.
    expect(asPairs(out)).toEqual(['vite@6.2.1', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('adds nothing when the name has a single resolution (already the chain answer)', () => {
    const out = repoWideNpmEntries([deps({ vite: 'latest' })], npmLock({ vite: ['8.3.5'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@8.3.5']);
  });

  it('adds nothing for a name no lockfile records', () => {
    const out = repoWideNpmEntries([deps({ vite: 'latest' }), deps({ vite: '^8.3.0' })], EMPTY, EMPTY);
    expect(asPairs(out)).toEqual(['vite@8.3.0']);
  });

  it('adds the versions of both lockfile formats when they disagree', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: 'latest' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['7.3.7'] }),
    );
    expect(asPairs(out)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('does not add the versions of another name', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: 'latest', ms: '^2.0.0' })],
      npmLock({ vite: ['8.3.5', '7.3.7'], ms: ['2.1.3', '2.0.0'] }),
      EMPTY,
    );
    // ms keeps its chain answer, the floor of ^2.0.0; vite gains every copy.
    expect(asPairs(out)).toEqual(['ms@2.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('both branches in one repository (different names, each decided on its own)', () => {
  it('applies the range branch to one name and the non-range branch to another', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0', ms: 'latest' }), deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'], ms: ['2.1.3', '2.0.0'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['ms@2.0.0', 'ms@2.1.3', 'vite@6.0.0', 'vite@8.3.5']);
  });

  it('for one name with a range and a non-range declarer, the name is ambiguous and only the non-range branch acts', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^6.0.0' }), deps({ vite: 'latest' })],
      npmLock({ vite: ['8.3.5', '7.3.7'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('lockfile observations behind the non-range branch', () => {
  it('the npm parser records every version, nested copies included, next to the lowest-only ambiguous entry', () => {
    const lock = npmLock({ vite: ['8.3.5', '7.3.7', '6.2.1'] });
    expect(lock.resolved.has('vite')).toBe(false);
    expect(lock.ambiguous.get('vite')).toBe('6.2.1');
    expect([...(lock.observed?.get('vite') ?? [])].sort()).toEqual(['6.2.1', '7.3.7', '8.3.5']);
  });

  it('the yarn parser records every version', () => {
    expect([...(yarnLock({ vite: ['8.3.5', '7.3.7'] }).observed?.get('vite') ?? [])].sort()).toEqual([
      '7.3.7',
      '8.3.5',
    ]);
  });

  it('the merge unions what both formats observed', () => {
    const merged = mergeLockfileResolutions([npmLock({ vite: ['8.3.5', '7.3.7'] }), yarnLock({ vite: ['6.2.1'] })]);
    expect(lockfileVersionsOf(merged, 'vite').sort()).toEqual(['6.2.1', '7.3.7', '8.3.5']);
  });

  it('a hand-built input without observations still contributes its resolved and ambiguous values', () => {
    const handBuilt: LockfileResolutions = {
      resolved: new Map([['a', '1.0.0']]),
      ambiguous: new Map([['b', '2.0.0']]),
    };
    const merged = mergeLockfileResolutions([handBuilt, EMPTY]);
    expect(lockfileVersionsOf(merged, 'a')).toEqual(['1.0.0']);
    expect(lockfileVersionsOf(merged, 'b')).toEqual(['2.0.0']);
    expect(lockfileVersionsOf(handBuilt, 'b')).toEqual(['2.0.0']);
    expect(lockfileVersionsOf(merged, 'c')).toEqual([]);
  });

  it('a version without a digit is not a version', () => {
    const merged = mergeLockfileResolutions([
      { resolved: new Map(), ambiguous: new Map(), observed: new Map([['a', new Set(['latest', '1.0.0'])]]) },
    ]);
    expect(lockfileVersionsOf(merged, 'a')).toEqual(['1.0.0']);
  });
});

describe('npmDeclarations', () => {
  it('lists every declaring manifest and field, not deduped, in manifest order (dependencies first)', () => {
    const decls = npmDeclarations([
      { dependencies: { a: '^1.0.0' }, devDependencies: { a: '^2.0.0', b: '3.0.0' } },
      { dependencies: { a: '^0.5.0' } },
    ]);
    expect(decls.map((d) => `${d.name}@${d.versionSpec}${d.isDev ? ':dev' : ''}`)).toEqual([
      'a@^1.0.0',
      'a@^2.0.0:dev',
      'b@3.0.0:dev',
      'a@^0.5.0',
    ]);
  });

  it('resolves an alias to its real name and drops local names', () => {
    const decls = npmDeclarations([
      { name: 'local', dependencies: { x: 'npm:real@^1.0.0', y: 'npm:local@^1.0.0' } },
      { dependencies: { local: '^1.0.0', malformed: 'npm:nover' } },
    ]);
    expect(decls.map((d) => `${d.name}@${d.versionSpec}`)).toEqual(['real@^1.0.0', 'malformed@npm:nover']);
  });

  it('collapses to unionNpmDeps by name', () => {
    const manifests: ParsedNpmManifest[] = [
      { dependencies: { a: '^1.0.0' }, devDependencies: { a: '^2.0.0' } },
      { devDependencies: { a: '^0.5.0' }, dependencies: { b: 'latest' } },
    ];
    const byName = new Map(unionNpmDeps(manifests).map((d) => [d.name, d]));
    expect(byName.get('a')?.versionSpec).toBe('^0.5.0');
    expect(byName.get('a')?.isDev).toBe(false);
    expect(byName.get('b')?.versionSpec).toBe('latest');
  });
});

// ---- additions only: property test against the previous algorithm -------------

// The chain as it was before the declarer floors (a copy, kept here so the
// comparison does not depend on the implementation under test).
function previousChain(
  manifests: ParsedNpmManifest[],
  npm: LockfileResolutions,
  yarn: LockfileResolutions,
): Array<{ name: string; version: string }> {
  const { resolved, ambiguous } = mergeLockfileResolutions([npm, yarn]);
  const floorOf = (spec: string): string | null => {
    const floor = spec.replace(/^[^0-9]*/, '');
    if (semver.valid(floor) !== null) return floor;
    if (floor === '' || semver.validRange(spec) === null) return null;
    return semver.minVersion(spec)?.version ?? null;
  };
  return unionNpmDeps(manifests)
    .map(({ name, versionSpec }) => ({
      name,
      version: resolved.get(name) ?? floorOf(versionSpec) ?? ambiguous.get(name) ?? '',
    }))
    .filter(({ version }) => /\d/.test(version));
}

// Deterministic generator (mulberry32), so a failure reproduces from the seed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Specs with their known floor (undefined: no range to compare).
const RANGES: Array<[string, string]> = [
  ['^6.0.0', '6.0.0'],
  ['^7.3.5', '7.3.5'],
  ['~5.4.2', '5.4.2'],
  ['^8.3.0', '8.3.0'],
  ['8.3.5', '8.3.5'],
  ['>=7.0.0 <8', '7.0.0'],
  ['7.x', '7.0.0'],
];
const NON_RANGES = ['latest', 'beta', '*', 'github:acme/pkg#main', 'file:../pkg'];
const VERSIONS = ['5.4.2', '6.0.0', '6.2.1', '7.3.5', '7.3.7', '8.3.0', '8.3.5', '8.4.0'];
const NAMES = ['vite', 'lodash', 'ms'];

describe('additions only: head is the previous chain plus exactly the declarer additions', () => {
  it('holds over seeded random repositories', () => {
    let withRangeAddition = 0;
    let withNonRangeAddition = 0;
    let unchanged = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const rand = rng(seed);
      const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];

      // Manifests: each declares a few names, each with a plain range or a non-range spec.
      const declared: Array<{ name: string; spec: string; floor: string | null }> = [];
      const manifests: ParsedNpmManifest[] = [];
      for (let m = 0, count = 1 + Math.floor(rand() * 4); m < count; m++) {
        const manifest: ParsedNpmManifest = { dependencies: {}, devDependencies: {} };
        for (const name of NAMES) {
          if (rand() < 0.45) continue;
          const isRange = rand() < 0.65;
          const [spec, floor] = isRange ? pick(RANGES) : [pick(NON_RANGES), null];
          if (rand() < 0.3) manifest.devDependencies![name] = spec;
          else manifest.dependencies![name] = spec;
          declared.push({ name, spec, floor });
        }
        manifests.push(manifest);
      }

      // Lockfiles: per name none, one version, or several (nested copies), in npm and/or yarn.
      const npmEntries: Record<string, string[]> = {};
      const yarnEntries: Record<string, string[]> = {};
      for (const name of NAMES) {
        const versionsFor = () => {
          const n = 1 + Math.floor(rand() * 3);
          return [...new Set(Array.from({ length: n }, () => pick(VERSIONS)))];
        };
        if (rand() < 0.6) npmEntries[name] = versionsFor();
        if (rand() < 0.2) yarnEntries[name] = versionsFor();
      }
      const npm = npmLock(npmEntries);
      const yarn = yarnLock(yarnEntries);

      const head = asPairs(repoWideNpmEntries(manifests, npm, yarn));
      const base = asPairs(previousChain(manifests, npm, yarn));

      // Additions only: nothing the previous chain produced is gone, and nothing is listed twice.
      expect(head, `seed ${seed}`).toEqual(expect.arrayContaining(base));
      expect(new Set(head).size, `seed ${seed}`).toBe(head.length);

      // Exactly the additions the two branches define, written from the generator's own facts.
      const lockVersions = (name: string) => new Set([...(npmEntries[name] ?? []), ...(yarnEntries[name] ?? [])]);
      const expectedExtra = new Set<string>();
      for (const { name, spec, floor } of declared) {
        const all = lockVersions(name);
        if (floor !== null) {
          // A format holding one version resolves the name; a format holding
          // several leaves it ambiguous without poisoning the other format;
          // two formats that both resolve it must agree.
          const perFormat = [npmEntries[name], yarnEntries[name]]
            .filter((versions): versions is string[] => versions !== undefined && versions.length === 1)
            .map((versions) => versions[0]);
          const resolved = perFormat.length > 0 && new Set(perFormat).size === 1 ? perFormat[0] : null;
          if (resolved !== null && !semver.satisfies(resolved, spec)) expectedExtra.add(`${name}@${floor}`);
        } else {
          for (const version of all) expectedExtra.add(`${name}@${version}`);
        }
      }
      expect(head, `seed ${seed}`).toEqual([...new Set([...base, ...expectedExtra])].sort());

      const added = head.filter((p) => !base.includes(p));
      if (added.length === 0) unchanged++;
      if (added.some((p) => declared.some((d) => d.floor !== null && p === `${d.name}@${d.floor}`))) withRangeAddition++;
      if (added.some((p) => declared.some((d) => d.floor === null && p.startsWith(`${d.name}@`)))) withNonRangeAddition++;
    }
    // Non-vacuity: the generator reaches unchanged cases and both kinds of addition.
    expect(unchanged).toBeGreaterThan(20);
    expect(withRangeAddition).toBeGreaterThan(20);
    expect(withNonRangeAddition).toBeGreaterThan(20);
  });
});
