/**
 * The npm dependency-age report's DEPRECATED status and prerelease floor strips.
 *
 * The npm registry marks a version deprecated with a message at
 * `versions["<version>"].deprecated`; a full packument has no top-level
 * `deprecated` field (verified on the packument of `request`). So a row is
 * DEPRECATED only when its shown version is a key of `versions` whose entry
 * carries a non-empty `deprecated` string. An empty-string message, a version
 * entry without the key, a row version that is not a key of `versions` (a
 * partial strip like `8` included: only the exact key counts), and a top-level
 * `deprecated` with a non-deprecated version entry all mean not deprecated.
 *
 * A shown floor strip that is not one version but whose first token (split on
 * whitespace or `|`) is a full version compares by that token, which covers a
 * prerelease floor strip: `>=1.0.0-beta.1 <2` shows `1.0.0-beta.1 <2` and
 * compares as 1.0.0-beta.1 (semver, so below 1.4.0, and 1.2.3-beta.1 is below
 * 1.2.3). A first token that is no version (`2#main`) stays UNKNOWN, and the
 * partial numeric strips keep their existing first-x.y.z reading.
 *
 * End to end through `analyzeDepAge` (GitHub client and registry `fetch`
 * mocked), plus `classifyStatus` directly for the strips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { classifyStatus } from '@/lib/deps/age-checker';
import { NOW, report, type Registry } from './helpers/dep-age-report';
import { pkg, type Scenario } from './helpers/npm-repo-fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const T = (v: string) => [v, '2026-01-01T00:00:00Z'] as const;

const single = (spec: string): Scenario => ({
  files: { 'package.json': pkg({ name: 'app', dependencies: { 'old-thing': spec } }) },
});

describe('analyzeDepAge: DEPRECATED from the shown version of the packument', () => {
  // 1.2.3 is deprecated on the registry, 1.2.4 (the latest) is not.
  const reg: Registry = {
    'old-thing': {
      latest: '1.2.4',
      versions: ['1.2.3', '1.2.4'],
      deprecatedVersions: { '1.2.3': 'use x' },
      time: Object.fromEntries([T('1.2.3'), T('1.2.4')]),
    },
  };

  it('the shown version 1.2.3 carries a deprecation message: DEPRECATED, isDeprecated true', async () => {
    const { rows, summary, degraded } = await report(single('1.2.3'), reg);
    expect(degraded).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      installedVersion: '1.2.3',
      status: 'DEPRECATED',
      isDeprecated: true,
    });
    expect(summary.deprecated).toBe(1);
  });

  it('the same package at 1.2.4 (no message on its entry): not DEPRECATED, isDeprecated false', async () => {
    const { rows, summary } = await report(single('1.2.4'), reg);
    expect(rows[0]).toMatchObject({
      installedVersion: '1.2.4',
      status: 'UP_TO_DATE',
      isDeprecated: false,
    });
    expect(summary.deprecated).toBe(0);
  });

  it('an empty-string message on the shown version: not deprecated', async () => {
    const { rows } = await report(single('1.2.3'), {
      'old-thing': {
        latest: '1.2.4',
        versions: ['1.2.3', '1.2.4'],
        deprecatedVersions: { '1.2.3': '' },
        time: Object.fromEntries([T('1.2.3'), T('1.2.4')]),
      },
    });
    expect(rows[0]).toMatchObject({ installedVersion: '1.2.3', status: 'OUTDATED', isDeprecated: false });
  });

  it('a version entry without a `deprecated` key: not deprecated', async () => {
    const { rows } = await report(single('1.2.3'), {
      'old-thing': {
        latest: '1.2.4',
        versions: ['1.2.3', '1.2.4'],
        time: Object.fromEntries([T('1.2.3'), T('1.2.4')]),
      },
    });
    expect(rows[0]).toMatchObject({ installedVersion: '1.2.3', status: 'OUTDATED', isDeprecated: false });
  });

  it('the shown version is not a key of `versions` (no `versions` map): not deprecated', async () => {
    const { rows } = await report(single('1.2.3'), {
      'old-thing': { latest: '1.2.4', time: Object.fromEntries([T('1.2.3'), T('1.2.4')]) },
    });
    expect(rows[0]).toMatchObject({ installedVersion: '1.2.3', status: 'OUTDATED', isDeprecated: false });
  });

  it('a partial strip `8` is not an exact key of `versions` (only 8.4.0 is deprecated): not deprecated', async () => {
    const s: Scenario = { files: { 'package.json': pkg({ name: 'app', dependencies: { 'old-thing': '^8' } }) } };
    const { rows } = await report(s, {
      'old-thing': {
        latest: '8.4.0',
        versions: ['8.4.0'],
        deprecatedVersions: { '8.4.0': 'gone' },
        time: Object.fromEntries([T('8.4.0')]),
      },
    });
    expect(rows[0]).toMatchObject({ installedVersion: '8', status: 'OUTDATED', isDeprecated: false });
  });

  it('a top-level `deprecated` with no message on the shown version: not deprecated (the top-level read is gone)', async () => {
    const { rows } = await report(single('1.2.3'), {
      'old-thing': {
        latest: '1.2.4',
        versions: ['1.2.3', '1.2.4'],
        deprecated: 'no longer maintained',
        time: Object.fromEntries([T('1.2.3'), T('1.2.4')]),
      },
    });
    expect(rows[0]).toMatchObject({ installedVersion: '1.2.3', status: 'OUTDATED', isDeprecated: false });
  });

  it('summary.deprecated counts the DEPRECATED rows (two packages, one deprecated)', async () => {
    const s: Scenario = {
      files: {
        'package.json': pkg({ name: 'app', dependencies: { 'old-thing': '1.2.3', fresh: '1.0.0' } }),
      },
    };
    const { rows, summary } = await report(s, {
      'old-thing': reg['old-thing'],
      fresh: { latest: '1.0.0', versions: ['1.0.0'], time: Object.fromEntries([T('1.0.0')]) },
    });
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['fresh', 'UP_TO_DATE'],
      ['old-thing', 'DEPRECATED'],
    ]);
    expect(summary.deprecated).toBe(1);
    expect(summary.total).toBe(2);
  });
});

describe('classifyStatus: a strip whose first token is a full version compares by it', () => {
  const cases: Array<[string, string, string]> = [
    ['1.0.0-beta.1 <2', '1.4.0', 'OUTDATED'], // floor of `>=1.0.0-beta.1 <2`
    ['1.0.0-beta.1 <2', '2.1.0', 'MAJOR_BEHIND'],
    ['1.2.3-beta.1 || 2', '1.2.3', 'OUTDATED'], // a prerelease sorts below its release
    ['1.0.0-beta.1', '1.0.0', 'OUTDATED'], // a full prerelease (unchanged: the full parse)
    // unchanged readings, pinned so the first-token path does not steal them
    ['2#main', '3.0.0', 'UNKNOWN'], // first token is no version
    ['8', '8.4.0', 'OUTDATED'], // partial numeric strip: coerced to 8.0.0
    ['7.3.5 <8', '8.4.0', 'MAJOR_BEHIND'], // partial numeric strip wins over the token path
    ['1.x', '1.4.0', 'OUTDATED'], // x-range strip: coerced to 1.0.0
    ['1.2.3.tgz', '3.0.0', 'UNKNOWN'], // a first token that is not a full version
    ['github:acme/widget2#main', '3.0.0', 'UNKNOWN'],
  ];
  for (const [installed, latest, want] of cases) {
    it(`installed ${installed} against latest ${latest}: ${want}`, () => {
      expect(classifyStatus(installed, latest, false)).toBe(want);
    });
  }
});
