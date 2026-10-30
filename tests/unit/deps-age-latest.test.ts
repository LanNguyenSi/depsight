/**
 * The version the npm dependency-age report compares against, and the status
 * it computes. `dist-tags.latest` normally; when that tag is a prerelease
 * (prisma publishes its next major as `8.0.0-rc.29` under `latest` while 7.10.1
 * is the newest stable) the newest stable version of the packument, found among
 * the `versions` keys, or among the `time` keys (minus `created` / `modified`)
 * only when the packument has no `versions` map, because `time` keeps
 * unpublished versions; the tag stays when the packument has no stable version.
 * Status compares with semver, so a prerelease installed version sorts below
 * its release and does not break the comparison; a shown version that is no
 * version (a git or URL spec) has status UNKNOWN.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { classifyStatus, pickLatestVersion } from '@/lib/deps/age-checker';
import { NOW, report, type Registry } from './helpers/dep-age-report';
import { pkg, v3, type Scenario } from './helpers/npm-repo-fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const packument = (latest: string | undefined, versions?: string[], time?: Record<string, string>) => ({
  ...(latest !== undefined ? { 'dist-tags': { latest } } : {}),
  ...(versions ? { versions: Object.fromEntries(versions.map((v) => [v, {}])) } : {}),
  ...(time ? { time } : {}),
});

describe('pickLatestVersion: dist-tags.latest against the newest stable version', () => {
  it('a stable tag wins (input: stable tag, newer stable version present)', () => {
    expect(pickLatestVersion(packument('1.2.0', ['1.2.0', '1.3.0']))).toBe('1.2.0');
  });

  it('a stable tag wins over a newer prerelease', () => {
    expect(pickLatestVersion(packument('1.2.0', ['1.2.0', '2.0.0-rc.1']))).toBe('1.2.0');
  });

  it('a prerelease tag: the highest stable among the `versions` keys (semver order, not string order)', () => {
    expect(pickLatestVersion(packument('8.0.0-rc.29', ['7.9.0', '7.10.1', '8.0.0-rc.1', '8.0.0-rc.29']))).toBe('7.10.1');
  });

  it('a prerelease tag and a packument with `time` only: the highest stable among the `time` keys, created and modified left out', () => {
    const time = { created: '2020-01-01T00:00:00Z', modified: '2026-10-01T00:00:00Z', '7.10.1': 'x', '8.0.0-rc.29': 'x', '7.9.0': 'x' };
    expect(pickLatestVersion(packument('8.0.0-rc.29', undefined, time))).toBe('7.10.1');
  });

  it('a prerelease tag with a `versions` map: a stable version only in `time` is ignored (the map says what is published), the tag stays', () => {
    expect(pickLatestVersion(packument('8.0.0-rc.29', ['8.0.0-rc.29'], { '7.10.1': 'x' }))).toBe('8.0.0-rc.29');
  });

  it('a prerelease tag and an unpublished higher stable version (in `time`, not in `versions`): the highest published stable', () => {
    const time = { '7.9.0': 'x', '7.10.1': 'x', '8.0.0-rc.29': 'x', unpublished: 'x' };
    expect(pickLatestVersion(packument('8.0.0-rc.29', ['7.9.0', '8.0.0-rc.29'], time))).toBe('7.9.0');
  });

  it('a `versions` map that is not an object (an array, null) counts as absent: the `time` keys are read', () => {
    const time = { '7.9.0': 'x' };
    expect(pickLatestVersion({ ...packument('8.0.0-rc.29', undefined, time), versions: ['7.10.1'] as never })).toBe('7.9.0');
    expect(pickLatestVersion({ ...packument('8.0.0-rc.29', undefined, time), versions: null as never })).toBe('7.9.0');
  });

  it('a prerelease tag and every version a prerelease: the tag stays', () => {
    expect(pickLatestVersion(packument('1.0.0-beta.3', ['1.0.0-beta.1', '1.0.0-beta.3']))).toBe('1.0.0-beta.3');
  });

  it('a prerelease tag and no `versions` or `time` at all: the tag stays', () => {
    expect(pickLatestVersion(packument('1.0.0-beta.3'))).toBe('1.0.0-beta.3');
  });

  it('a prerelease tag and a stable version higher than the tag base (2.0.0 against 1.0.0-beta): the stable version', () => {
    expect(pickLatestVersion(packument('1.0.0-beta.3', ['1.0.0-beta.3', '2.0.0']))).toBe('2.0.0');
  });

  it('a tag that is no semver version (`next`): the tag stays', () => {
    expect(pickLatestVersion(packument('next', ['1.0.0']))).toBe('next');
  });

  it('no `dist-tags` (or no latest): the empty string', () => {
    expect(pickLatestVersion(packument(undefined, ['1.0.0']))).toBe('');
    expect(pickLatestVersion({ 'dist-tags': {} })).toBe('');
  });

  it('keys in `versions` that are no version are ignored', () => {
    expect(pickLatestVersion(packument('2.0.0-rc.1', ['not-a-version', '1.5.0', '2.0.0-rc.1']))).toBe('1.5.0');
  });
});

describe('classifyStatus: semver comparison', () => {
  const cases: Array<[string, string, string]> = [
    ['1.2.3', '1.2.3', 'UP_TO_DATE'],
    ['1.2.0', '1.3.0', 'OUTDATED'],
    ['1.2.3', '1.2.9', 'OUTDATED'],
    ['1.9.9', '2.0.0', 'MAJOR_BEHIND'],
    ['9.0.0', '8.4.0', 'UP_TO_DATE'], // installed ahead of the latest
    ['8', '8.4.0', 'OUTDATED'], // a partial floor strip
    ['7.3.5 <8', '8.4.0', 'MAJOR_BEHIND'], // a range strip: its first version
    ['7.3.5-beta.2', '7.3.5', 'OUTDATED'], // a prerelease sorts below its release
    ['7.3.5-beta.2', '7.3.5-beta.2', 'UP_TO_DATE'],
    ['7.3.5-beta.1', '7.3.5-beta.2', 'OUTDATED'],
    ['7.3.5-rc.1', '7.3.5-beta.2', 'UP_TO_DATE'], // rc sorts above beta
    ['5.0.0-beta.1', '7.10.1', 'MAJOR_BEHIND'],
    ['8.0.0-rc.1', '7.10.1', 'UP_TO_DATE'], // a prerelease of a newer major is not behind
    ['7.10.0-rc.1', '7.10.1', 'OUTDATED'],
    ['1.x', '1.4.0', 'OUTDATED'], // an x-range strip is read as its first version, 1.0.0
    ['1.x', '2.0.0', 'MAJOR_BEHIND'],
    ['1.2.3||2.0.0', '3.0.0', 'MAJOR_BEHIND'], // the first alternative of a range strip
    // a shown string that is no version has no status (its digits are not a version)
    ['2#main', '3.0.0', 'UNKNOWN'],
    ['github:acme/widget2#main', '3.0.0', 'UNKNOWN'],
    ['file:../a', '3.0.0', 'UNKNOWN'],
    ['https://example.com/pkg-1.2.3.tgz', '3.0.0', 'UNKNOWN'],
    ['1.2.3.tgz', '3.0.0', 'UNKNOWN'],
    ['2x', '3.0.0', 'UNKNOWN'], // digits glued to letters are no version
    ['latest', '3.0.0', 'UNKNOWN'],
  ];
  for (const [installed, latest, want] of cases) {
    it(`installed ${installed} against latest ${latest}: ${want}`, () => {
      expect(classifyStatus(installed, latest, false)).toBe(want);
    });
  }

  it('DEPRECATED beats everything; empty, `unknown` and a missing latest are UNKNOWN', () => {
    expect(classifyStatus('1.0.0', '2.0.0', true)).toBe('DEPRECATED');
    expect(classifyStatus('', '1.0.0', false)).toBe('UNKNOWN');
    expect(classifyStatus('unknown', '1.0.0', false)).toBe('UNKNOWN');
    expect(classifyStatus('1.0.0', '', false)).toBe('UNKNOWN');
  });

  it('a latest that is no version at all is UNKNOWN, not a guess', () => {
    expect(classifyStatus('1.0.0', 'next', false)).toBe('UNKNOWN');
  });
});

describe('analyzeDepAge: a prerelease dist-tags.latest', () => {
  const T = (v: string, day: string) => [v, `2026-${day}T00:00:00Z`] as const;
  const prisma: Registry = {
    prisma: {
      latest: '8.0.0-rc.29',
      versions: ['5.22.0', '7.10.1', '8.0.0-rc.1', '8.0.0-rc.29'],
      time: Object.fromEntries([
        T('5.22.0', '01-01'),
        T('7.10.1', '09-01'),
        T('8.0.0-rc.1', '10-01'),
        T('8.0.0-rc.29', '10-20'),
      ]),
    },
  };
  const single = (spec: string, lock?: string): Scenario => ({
    files: {
      'package.json': pkg({ name: 'app', dependencies: { prisma: spec } }),
      ...(lock ? { 'package-lock.json': lock } : {}),
    },
  });

  it('prisma 5.22.0 installed: MAJOR_BEHIND against 7.10.1, latestVersion and latestPublishedAt of 7.10.1', async () => {
    const { rows } = await report(single('5.22.0'), prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      installedVersion: '5.22.0',
      latestVersion: '7.10.1',
      status: 'MAJOR_BEHIND',
      updateAvailable: true,
    });
    expect(rows[0].latestPublishedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('prisma 7.10.1 installed: UP_TO_DATE (not behind the 8.0.0-rc tag)', async () => {
    const { rows } = await report(single('7.10.1'), prisma);
    expect(rows[0]).toMatchObject({ installedVersion: '7.10.1', latestVersion: '7.10.1', status: 'UP_TO_DATE', updateAvailable: false });
  });

  it('the lockfile version is what is compared: ^7.0.0 locked 7.10.1 is UP_TO_DATE', async () => {
    const { rows } = await report(single('^7.0.0', v3({ 'node_modules/prisma': '7.10.1' })), prisma);
    expect(rows[0]).toMatchObject({ installedVersion: '7.10.1', status: 'UP_TO_DATE' });
  });

  it('a prerelease installed (8.0.0-rc.1) is not behind the newest stable: UP_TO_DATE, no throw', async () => {
    const { rows } = await report(single('8.0.0-rc.1'), prisma);
    expect(rows[0]).toMatchObject({ installedVersion: '8.0.0-rc.1', status: 'UP_TO_DATE' });
  });

  it('a packument with `time` but no `versions` (the stable version only in `time`): still 7.10.1', async () => {
    const { time } = prisma.prisma as { time: Record<string, string> };
    const { rows } = await report(single('5.22.0'), { prisma: { latest: '8.0.0-rc.29', time } });
    expect(rows[0]).toMatchObject({ latestVersion: '7.10.1', status: 'MAJOR_BEHIND' });
  });

  it('a git spec whose digits strip to `2#main` is no version: UNKNOWN row, not MAJOR_BEHIND', async () => {
    const reg: Registry = { lib: { latest: '3.0.0', time: { '3.0.0': '2026-01-01T00:00:00Z' } } };
    const s: Scenario = { files: { 'package.json': pkg({ name: 'app', dependencies: { lib: 'github:acme/widget2#main' } }) } };
    const { rows } = await report(s, reg);
    expect(rows[0]).toMatchObject({ installedVersion: '2#main', status: 'UNKNOWN', updateAvailable: false });
  });

  it('an unpublished higher stable version in `time` is not chosen (prerelease tag, `versions` without it)', async () => {
    const reg: Registry = {
      pkg: {
        latest: '8.0.0-rc.29',
        versions: ['5.22.0', '7.9.0', '8.0.0-rc.29'],
        time: { '5.22.0': '2026-01-01T00:00:00Z', '7.9.0': '2026-08-01T00:00:00Z', '7.10.1': '2026-09-01T00:00:00Z', '8.0.0-rc.29': '2026-10-20T00:00:00Z' },
      },
    };
    const s: Scenario = { files: { 'package.json': pkg({ name: 'app', dependencies: { pkg: '5.22.0' } }) } };
    const { rows } = await report(s, reg);
    expect(rows[0]).toMatchObject({ latestVersion: '7.9.0', status: 'MAJOR_BEHIND' });
    expect(rows[0].latestPublishedAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('a package with only prereleases keeps dist-tags.latest and compares prereleases with semver', async () => {
    const reg: Registry = {
      beta: {
        latest: '1.0.0-beta.3',
        versions: ['1.0.0-beta.1', '1.0.0-beta.3'],
        time: { '1.0.0-beta.1': '2026-05-01T00:00:00Z', '1.0.0-beta.3': '2026-06-01T00:00:00Z' },
      },
    };
    const s: Scenario = { files: { 'package.json': pkg({ name: 'app', dependencies: { beta: '1.0.0-beta.1' } }) } };
    const { rows } = await report(s, reg);
    expect(rows[0]).toMatchObject({
      installedVersion: '1.0.0-beta.1',
      latestVersion: '1.0.0-beta.3',
      status: 'OUTDATED',
    });
    expect(rows[0].latestPublishedAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('a stable dist-tags.latest is untouched even when a higher stable version exists (the tag wins)', async () => {
    const reg: Registry = { lib: { latest: '1.2.0', versions: ['1.2.0', '1.3.0'], time: { '1.2.0': '2026-01-01T00:00:00Z', '1.3.0': '2026-02-01T00:00:00Z' } } };
    const s: Scenario = { files: { 'package.json': pkg({ name: 'app', dependencies: { lib: '1.2.0' } }) } };
    const { rows } = await report(s, reg);
    expect(rows[0]).toMatchObject({ latestVersion: '1.2.0', status: 'UP_TO_DATE' });
  });
});
