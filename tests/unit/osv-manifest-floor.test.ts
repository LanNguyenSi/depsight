/**
 * `manifestFloor` returns a version the spec admits. A leading `^`, `~`, `=`,
 * `>=` or a (v-prefixed) exact version keeps the operator-stripped form; every
 * other valid range takes `semver.minVersion`, so an upper-bound-only spec
 * (`<2.0.0`) no longer yields its own excluded bound.
 */
import { describe, it, expect } from 'vitest';
import semver from 'semver';
import { manifestFloor, repoWideNpmEntries } from '@/lib/cve/osv';
import type { LockfileResolutions } from '@/lib/manifest-discovery';

describe('manifestFloor', () => {
  describe('forms that keep the stripped version', () => {
    it.each([
      ['^1.2.3', '1.2.3'],
      ['~1.2.3', '1.2.3'],
      ['=1.2.3', '1.2.3'],
      ['>=1.2.3', '1.2.3'],
      ['>= 1.2.3', '1.2.3'],
      ['v1.2.3', '1.2.3'],
      ['1.2.3', '1.2.3'],
      ['^1.2.3-beta.1', '1.2.3-beta.1'],
    ])('%s -> %s', (spec, expected) => {
      expect(manifestFloor(spec)).toBe(expected);
      expect(semver.satisfies(expected, spec)).toBe(true);
    });
  });

  describe('forms that take semver.minVersion', () => {
    it.each([
      ['<2.0.0', '0.0.0'],
      ['<=1.5.0', '0.0.0'],
      ['>1.0.0', '1.0.1'],
      ['>1.0.0 <2.0.0', '1.0.1'],
      ['>=1.2.0 <2.0.0', '1.2.0'],
      ['1.2.3 - 2.0.0', '1.2.3'],
      ['^1.2.3 || ^3.0.0', '1.2.3'],
      ['<1.0.0 || >=3.0.0', '0.0.0'],
      ['1.x', '1.0.0'],
      ['~1.2', '1.2.0'],
      ['^8', '8.0.0'],
    ])('%s -> %s', (spec, expected) => {
      expect(manifestFloor(spec)).toBe(expected);
      expect(semver.satisfies(expected, spec)).toBe(true);
    });
  });

  describe('no usable floor', () => {
    it.each(['*', 'x', 'latest', 'workspace:*', '', 'file:../pkg'])('digit-free or non-range %s -> null', (spec) => {
      expect(manifestFloor(spec)).toBeNull();
    });

    it('an unsatisfiable range yields null instead of its stripped bound outside the range', () => {
      expect(semver.minVersion('>=2.0.0 <1.0.0')).toBeNull();
      expect(manifestFloor('>=2.0.0 <1.0.0')).toBeNull();
      expect(manifestFloor('<0.0.0')).toBeNull();
    });

    it('an invalid spec keeps the stripped form when it is an exact version', () => {
      expect(semver.validRange('<<2.0.0')).toBeNull();
      expect(manifestFloor('<<2.0.0')).toBe('2.0.0');
    });

    it('an invalid spec with no exact version after stripping yields null', () => {
      expect(manifestFloor('<<2.0')).toBeNull();
    });
  });
});

describe('callers of manifestFloor see the in-range floor', () => {
  const EMPTY: LockfileResolutions = { resolved: new Map(), ambiguous: new Map() };
  const pairs = (m: Array<{ name: string; version: string }>) => m.map((e) => `${e.name}@${e.version}`).sort();

  it('chain fallback: an upper-bound-only spec with no lockfile queries a version it admits', () => {
    const out = repoWideNpmEntries([{ dependencies: { foo: '<2.0.0' } }], EMPTY, EMPTY);
    expect(pairs(out)).toEqual(['foo@0.0.0']);
  });

  it('declarer floor: a range above the resolved version queries its lowest admitted version', () => {
    const resolved: LockfileResolutions = { resolved: new Map([['foo', '5.0.0']]), ambiguous: new Map() };
    const out = repoWideNpmEntries([{ dependencies: { foo: '>1.0.0 <3.0.0' } }], resolved, EMPTY);
    expect(pairs(out)).toEqual(['foo@1.0.1', 'foo@5.0.0']);
  });
});
