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
 *   no-resolution     a name with no single merged resolution (ambiguous
 *                     across lockfiles, or recorded by none): every version any
 *                     lockfile records for it is queried, and a plain-range
 *                     declarer's floor too, unless some recorded version
 *                     satisfies that declarer's range
 *
 * All three only ever ADD to the chain the code produced before. The exact query
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

  it('keeps the resolved-name behaviour when the one resolution satisfies the range', () => {
    // The ambiguous/unresolved branch does not run for a single resolution.
    expect(asPairs(repoWideNpmEntries([deps({ vite: '^8.3.0' })], npmLock({ vite: ['8.3.5'] }), EMPTY))).toEqual([
      'vite@8.3.5',
    ]);
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
    // Disagreement leaves the name ambiguous: the chain answers with the floor
    // 6.0.0 and both formats' versions are queried next to it.
    expect(asPairs(disagree)).toEqual(['vite@6.0.0', 'vite@8.3.5', 'vite@8.4.0']);
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
    // ms is a plain range with two lockfile copies (no single resolution): its
    // floor 2.0.0 and both copies; vite gains every copy.
    expect(asPairs(out)).toEqual(['ms@2.0.0', 'ms@2.1.3', 'vite@7.3.7', 'vite@8.3.5']);
  });
});

describe('no single resolution: ambiguous or unresolved name', () => {
  const ambiguousLock = () => npmLock({ vite: ['8.3.5', '7.3.7'] });
  const singleLock = () => npmLock({ vite: ['8.3.5'] });

  // Each row: the declared specs, then the expected pairs for a name with a single
  // resolution (8.3.5), an ambiguous one (8.3.5 and 7.3.7 in one lockfile) and an
  // unresolved one (no lockfile). The chain answer is part of every set.
  const matrix: Array<[string, string[], string[], string[], string[]]> = [
    ['one plain range', ['^8.3.0'], ['vite@8.3.5'], ['vite@7.3.7', 'vite@8.3.0', 'vite@8.3.5'], ['vite@8.3.0']],
    [
      'two plain ranges',
      ['^8.3.0', '^6.0.0'],
      ['vite@6.0.0', 'vite@8.3.5'],
      ['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5'],
      ['vite@6.0.0', 'vite@8.3.0'],
    ],
    ['one non-range (latest)', ['latest'], ['vite@8.3.5'], ['vite@7.3.7', 'vite@8.3.5'], []],
    ['one wildcard', ['*'], ['vite@8.3.5'], ['vite@7.3.7', 'vite@8.3.5'], []],
    [
      'plain range and non-range',
      ['^6.0.0', 'latest'],
      ['vite@6.0.0', 'vite@8.3.5'],
      ['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5'],
      ['vite@6.0.0'],
    ],
    [
      'plain range and wildcard',
      ['^6.0.0', '*'],
      ['vite@6.0.0', 'vite@8.3.5'],
      ['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5'],
      ['vite@6.0.0'],
    ],
  ];

  it.each(matrix)('%s: single resolution', (_label, specs, single) => {
    const out = repoWideNpmEntries(specs.map((spec) => deps({ vite: spec })), singleLock(), EMPTY);
    expect(asPairs(out)).toEqual(single);
  });

  it.each(matrix)('%s: ambiguous name', (_label, specs, _single, ambiguous) => {
    const out = repoWideNpmEntries(specs.map((spec) => deps({ vite: spec })), ambiguousLock(), EMPTY);
    expect(asPairs(out)).toEqual(ambiguous);
  });

  it.each(matrix)('%s: unresolved name', (_label, specs, _single, _ambiguous, unresolved) => {
    const out = repoWideNpmEntries(specs.map((spec) => deps({ vite: spec })), EMPTY, EMPTY);
    expect(asPairs(out)).toEqual(unresolved);
  });

  // The floor rule for a plain-range declarer of a name without a single
  // resolution. Observed versions: vite 8.3.5 and 7.3.7. The chain answer is the
  // floor of the lowest declared range and is part of every set; the observed
  // copies are always queried. Each row is one combination of declarers.
  it.each([
    ['satisfied by the higher observed version: no floor', ['^6.0.0', '^8.3.0'], ['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']],
    ['satisfied by the lower observed version: no floor', ['^6.0.0', '^7.3.0'], ['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']],
    [
      'satisfied by no observed version: floor',
      ['^8.3.0', '^9.0.0'],
      ['vite@7.3.7', 'vite@8.3.0', 'vite@8.3.5', 'vite@9.0.0'],
    ],
    [
      'between the observed versions and satisfied by neither: floor',
      ['^6.0.0', '^7.5.0'],
      ['vite@6.0.0', 'vite@7.3.7', 'vite@7.5.0', 'vite@8.3.5'],
    ],
    [
      'several declarers, mixed',
      ['^5.0.0', '~7.3.0', '^8.3.0', '^9.0.0', 'latest'],
      ['vite@5.0.0', 'vite@7.3.7', 'vite@8.3.5', 'vite@9.0.0'],
    ],
    [
      'an exact pin that is an observed version: no floor beyond the copy',
      ['^6.0.0', '7.3.7'],
      ['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5'],
    ],
    [
      'an exact pin that is not observed: floor',
      ['^6.0.0', '7.3.6'],
      ['vite@6.0.0', 'vite@7.3.6', 'vite@7.3.7', 'vite@8.3.5'],
    ],
  ])('ambiguous name, %s', (_label, specs, expected) => {
    const out = repoWideNpmEntries(specs.map((spec) => deps({ vite: spec })), ambiguousLock(), EMPTY);
    expect(asPairs(out)).toEqual(expected);
  });

  it('ambiguous name: a prerelease copy does not satisfy a stable range, so the floor is queried', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^6.0.0' }), deps({ vite: '^8.3.0' })],
      npmLock({ vite: ['8.4.0-beta.1', '7.3.7'] }),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.0', 'vite@8.4.0-beta.1']);
  });

  it('ambiguous across formats: a copy recorded by either lockfile satisfies a range', () => {
    // npm resolves vite to 8.3.5, yarn to 7.3.7: no single resolution. ^7.0.0 is
    // satisfied by the yarn copy, ^8.3.0 by the npm copy, ^6.0.0 by neither.
    const out = repoWideNpmEntries(
      [deps({ vite: '^6.0.0' }), deps({ vite: '^7.0.0' }), deps({ vite: '^8.3.0' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['7.3.7'] }),
    );
    expect(asPairs(out)).toEqual(['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('unresolved name: every plain-range floor is queried, whatever the ranges overlap', () => {
    // No lockfile records vite: nothing can satisfy a range, so both floors join
    // (the chain keeps only the lowest).
    const out = repoWideNpmEntries([deps({ vite: '^8.3.0' }), deps({ vite: '^8.5.0' })], EMPTY, EMPTY);
    expect(asPairs(out)).toEqual(['vite@8.3.0', 'vite@8.5.0']);
  });

  it('a single resolution in one format keeps the old answer even when the other format holds several', () => {
    // npm resolves vite to 8.3.5; yarn records 8.3.5 and 7.3.7. The name has one
    // merged resolution, so the range branch alone applies: the unsatisfied
    // ^6.0.0 floor joins, the yarn copy 7.3.7 does not.
    const out = repoWideNpmEntries(
      [deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['8.3.5', '7.3.7'] }),
    );
    expect(asPairs(out)).toEqual(['vite@6.0.0', 'vite@8.3.5']);
    // The same repository with a wildcard declarer: every recorded version.
    const wildcard = repoWideNpmEntries(
      [deps({ vite: '*' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['8.3.5', '7.3.7'] }),
    );
    expect(asPairs(wildcard)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it('yarn.lock with two versions beside a higher and a lower range: the lower floor and both copies', () => {
    // vite 8.3.5 and 7.3.7, root ^8.3.0, docs/ ^6.0.0: the chain answer is 6.0.0
    // (the lowest declared floor); no observed version satisfies ^6.0.0 and 8.3.5
    // satisfies ^8.3.0, so 8.3.0 is not queried.
    const ranges = [deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })];
    expect(asPairs(repoWideNpmEntries(ranges, EMPTY, yarnLock({ vite: ['8.3.5', '7.3.7'] })))).toEqual([
      'vite@6.0.0',
      'vite@7.3.7',
      'vite@8.3.5',
    ]);
  });

  it('no lockfile: the higher range floor is queried too (the chain keeps only the lowest)', () => {
    const ranges = [deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })];
    expect(asPairs(repoWideNpmEntries(ranges, EMPTY, EMPTY))).toEqual(['vite@6.0.0', 'vite@8.3.0']);
  });

  it('a lockfile copy outside every declared range is queried as well (a stale lockfile can still install it)', () => {
    const out = repoWideNpmEntries([deps({ vite: '^8.3.0' })], npmLock({ vite: ['8.3.5', '4.0.0'] }), EMPTY);
    expect(asPairs(out)).toEqual(['vite@4.0.0', 'vite@8.3.0', 'vite@8.3.5']);
  });

  it('reads devDependencies and an npm: alias of an ambiguous name like a dependency', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0' }), { devDependencies: { vite: '^6.0.0' } }, deps({ bundler: 'npm:vite@~5.4.2' })],
      ambiguousLock(),
      EMPTY,
    );
    expect(asPairs(out)).toEqual(['vite@5.4.2', 'vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']);
  });

  it('only the ambiguous name widens; a neighbour with a single resolution keeps the old behaviour', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0', ms: '^2.0.0' }), deps({ ms: '^1.0.0' })],
      npmLock({ vite: ['8.3.5', '7.3.7'], ms: ['2.1.3'] }),
      EMPTY,
    );
    // ms: resolved 2.1.3 satisfies ^2.0.0, not ^1.0.0, so only the ^1.0.0 floor joins.
    expect(asPairs(out)).toEqual(['ms@1.0.0', 'ms@2.1.3', 'vite@7.3.7', 'vite@8.3.0', 'vite@8.3.5']);
  });

  // Which spec counts as a plain range, and what its floor is, for a name with no
  // single resolution. A plain range is what semver.validRange accepts and is not
  // the wildcard; its floor is the exact version after the operator or the
  // minVersion of the whole range. The lockfile holds 8.3.5 and 7.3.7.
  it.each([
    ['^8.3.0', ['vite@8.3.0']],
    ['~5.4.2', ['vite@5.4.2']],
    ['>=6.1.0 <7', ['vite@6.1.0']],
    ['7.x', ['vite@7.0.0']],
    ['8.3.5', ['vite@8.3.5']],
    ['6.0.0 - 6.5.0', ['vite@6.0.0']],
    ['1.x || 8.x', ['vite@1.0.0']],
    ['^6.0.0-beta.1', ['vite@6.0.0-beta.1']],
  ])('plain range %j: floor is queried beside both lockfile copies', (spec, floor) => {
    const out = repoWideNpmEntries([deps({ vite: spec })], ambiguousLock(), EMPTY);
    expect(asPairs(out)).toEqual([...new Set([...floor, 'vite@7.3.7', 'vite@8.3.5'])].sort());
  });

  it('a `||` union gets the floor of its lowest alternative only', () => {
    const out = repoWideNpmEntries([deps({ vite: '^1.0.0 || ^8.0.0' })], EMPTY, EMPTY);
    expect(asPairs(out)).toEqual(['vite@1.0.0']);
  });

  it('a range that admits no version has no floor: the copies and the chain answer are queried', () => {
    const out = repoWideNpmEntries([deps({ vite: '>2 <1' })], ambiguousLock(), EMPTY);
    expect(asPairs(out)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it.each(['*', 'x', 'X', ''])('wildcard %j is not a plain range: no floor, only the copies', (spec) => {
    const out = repoWideNpmEntries([deps({ vite: spec })], ambiguousLock(), EMPTY);
    expect(asPairs(out)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
  });

  it.each(['latest', 'beta', 'github:acme/vite#main', 'file:../vite', 'workspace:*'])(
    'non-range %j beside an ambiguous name: no floor, only the copies',
    (spec) => {
      const out = repoWideNpmEntries([deps({ vite: spec })], ambiguousLock(), EMPTY);
      expect(asPairs(out)).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    },
  );

  it('an unresolved name with only non-range declarers queries nothing', () => {
    expect(asPairs(repoWideNpmEntries([deps({ vite: 'latest' }), deps({ vite: '*' })], EMPTY, EMPTY))).toEqual([]);
  });

  it('the copies of both lockfile formats are queried when the formats disagree', () => {
    const out = repoWideNpmEntries(
      [deps({ vite: '^8.3.0' }), deps({ vite: '^6.0.0' })],
      npmLock({ vite: ['8.3.5'] }),
      yarnLock({ vite: ['7.3.7'] }),
    );
    expect(asPairs(out)).toEqual(['vite@6.0.0', 'vite@7.3.7', 'vite@8.3.5']);
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
    let withNoResolutionAddition = 0;
    let satisfiedFloorSkipped = 0;
    let ambiguousFloorAdded = 0;
    let unresolvedFloorAdded = 0;
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

      // Exactly the additions the branches define, written from the generator's own facts.
      const lockVersions = (name: string) => new Set([...(npmEntries[name] ?? []), ...(yarnEntries[name] ?? [])]);
      const expectedExtra = new Set<string>();
      let noResolutionSeed = false;
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
          if (resolved === null) {
            // No single resolution: every lockfile version of the name, and the
            // declarer's floor unless some recorded version already satisfies
            // its range (a name no lockfile records has none to satisfy it).
            for (const version of all) expectedExtra.add(`${name}@${version}`);
            if ([...all].some((version) => semver.satisfies(version, spec))) {
              if (!base.includes(`${name}@${floor}`)) satisfiedFloorSkipped++;
            } else {
              expectedExtra.add(`${name}@${floor}`);
              if (all.size === 0) unresolvedFloorAdded++;
              else ambiguousFloorAdded++;
            }
            if (all.size > 0 && ![...all].every((version) => version === floor)) noResolutionSeed = true;
          } else if (!semver.satisfies(resolved, spec)) expectedExtra.add(`${name}@${floor}`);
        } else {
          for (const version of all) expectedExtra.add(`${name}@${version}`);
        }
      }
      expect(head, `seed ${seed}`).toEqual([...new Set([...base, ...expectedExtra])].sort());

      if (noResolutionSeed) withNoResolutionAddition++;
      const added = head.filter((p) => !base.includes(p));
      if (added.length === 0) unchanged++;
      if (added.some((p) => declared.some((d) => d.floor !== null && p === `${d.name}@${d.floor}`))) withRangeAddition++;
      if (added.some((p) => declared.some((d) => d.floor === null && p.startsWith(`${d.name}@`)))) withNonRangeAddition++;
    }
    // Non-vacuity: the generator reaches unchanged cases and both kinds of addition.
    expect(unchanged).toBeGreaterThan(20);
    expect(withRangeAddition).toBeGreaterThan(20);
    expect(withNonRangeAddition).toBeGreaterThan(20);
    expect(withNoResolutionAddition).toBeGreaterThan(20);
    // ... and each side of the no-resolution floor rule: skipped because an observed
    // version satisfies the range, added for an ambiguous name, added for an unresolved one.
    expect(satisfiedFloorSkipped).toBeGreaterThan(20);
    expect(ambiguousFloorAdded).toBeGreaterThan(20);
    expect(unresolvedFloorAdded).toBeGreaterThan(20);
  });
});
