/**
 * Unit tests for the pure npm lockfile helpers in lib/manifest-discovery.ts.
 *
 * Both functions are synchronous and have no I/O, so no mocks are needed.
 * The I/O wrapper (fetchNpmLockfileResolutions) and its end-to-end wiring
 * into collectDeps are covered by tests/unit/osv-lockfile.test.ts.
 *
 * discoverLockfilePaths:
 *   - always includes repo-root package-lock.json
 *   - includes co-located lockfile next to each discovered package.json
 *   - deduplicates (root manifest → no duplicate root lockfile entry)
 *   - handles deep workspace paths (packages/a/package.json → packages/a/package-lock.json)
 *
 * parseNpmLockfileContentsList:
 *   - lockfileVersion 3 packages map (the common modern format)
 *   - lockfileVersion 1 dependencies map (best-effort fallback)
 *   - scoped packages (@scope/name) parsed from node_modules key
 *   - workspace-nested entry (packages/a/node_modules/dep) parsed correctly
 *   - LOWEST resolved version kept across multiple entries (security-conservative)
 *   - empty list → empty map
 *   - malformed JSON entry → silently skipped, other entries still parsed
 *   - MONOREPO: root lockfile entry covers a workspace dep
 */

import { describe, it, expect } from 'vitest';

import {
  discoverLockfilePaths,
  parseNpmLockfileContentsList,
} from '@/lib/manifest-discovery';

// ---- Helpers ----------------------------------------------------------------

/** Minimal lockfileVersion 3 object with the given flat dep map. */
function lockV3(deps: Record<string, string>): object {
  const packages: Record<string, { version?: string }> = { '': {} };
  for (const [name, version] of Object.entries(deps)) {
    packages[`node_modules/${name}`] = { version };
  }
  return { lockfileVersion: 3, name: 'root', version: '0.0.0', packages };
}

/** Minimal lockfileVersion 1 object with the given flat dep map. */
function lockV1(deps: Record<string, string>): object {
  const dependencies: Record<string, { version: string }> = {};
  for (const [name, version] of Object.entries(deps)) {
    dependencies[name] = { version };
  }
  return { lockfileVersion: 1, dependencies };
}

function json(obj: object): string {
  return JSON.stringify(obj);
}

// ============================================================================
// discoverLockfilePaths
// ============================================================================

describe('discoverLockfilePaths', () => {
  it('always includes the repo-root package-lock.json', () => {
    expect(discoverLockfilePaths([])).toContain('package-lock.json');
  });

  it('deduplicates when package.json is at the root (same as root lockfile)', () => {
    const paths = discoverLockfilePaths(['package.json']);
    expect(paths).toEqual(['package-lock.json']); // only one entry
  });

  it('adds a co-located lockfile for each non-root manifest', () => {
    const paths = discoverLockfilePaths(['packages/a/package.json']);
    expect(paths).toContain('package-lock.json');
    expect(paths).toContain('packages/a/package-lock.json');
    expect(paths).toHaveLength(2);
  });

  it('handles multiple workspace manifests without duplicates', () => {
    const paths = discoverLockfilePaths([
      'package.json',
      'packages/a/package.json',
      'packages/b/package.json',
    ]);
    expect(paths).toContain('package-lock.json');
    expect(paths).toContain('packages/a/package-lock.json');
    expect(paths).toContain('packages/b/package-lock.json');
    expect(paths).toHaveLength(3); // root + a + b (root already covered by package.json)
  });
});

// ============================================================================
// parseNpmLockfileContentsList
// ============================================================================

describe('parseNpmLockfileContentsList', () => {
  it('returns an empty map for an empty content list', () => {
    expect(parseNpmLockfileContentsList([])).toEqual(new Map());
  });

  it('parses lockfileVersion 3 packages map and returns resolved versions', () => {
    const map = parseNpmLockfileContentsList([
      json(lockV3({ glob: '10.5.0', lodash: '4.17.21' })),
    ]);
    expect(map.get('glob')).toBe('10.5.0');
    expect(map.get('lodash')).toBe('4.17.21');
  });

  it('parses lockfileVersion 1 dependencies map as best-effort fallback', () => {
    const map = parseNpmLockfileContentsList([json(lockV1({ semver: '7.6.3' }))]);
    expect(map.get('semver')).toBe('7.6.3');
  });

  it('handles scoped packages (@scope/name) in the packages map key', () => {
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/@babel/core': { version: '7.24.0' },
          'node_modules/@types/node': { version: '20.11.0' },
        },
      }),
    ]);
    expect(map.get('@babel/core')).toBe('7.24.0');
    expect(map.get('@types/node')).toBe('20.11.0');
  });

  it('parses workspace-nested entry (packages/a/node_modules/dep)', () => {
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'packages/a/node_modules/minimatch': { version: '9.0.4' },
        },
      }),
    ]);
    expect(map.get('minimatch')).toBe('9.0.4');
  });

  it('extracts the name after the LAST node_modules segment for deeply-nested keys (regression: greedy-regex fix)', () => {
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/foo/node_modules/glob': { version: '10.4.5' },
          'node_modules/bar/node_modules/@scope/pkg': { version: '2.1.0' },
        },
      }),
    ]);
    // The pre-fix greedy regex yielded junk keys ('foo/node_modules/glob',
    // 'bar/node_modules/@scope/pkg') so these names were never matched.
    expect(map.get('glob')).toBe('10.4.5');
    expect(map.get('@scope/pkg')).toBe('2.1.0');
  });

  it('skips workspace self-entries (no node_modules segment) rather than treating them as deps', () => {
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'packages/a': { version: '1.0.0' }, // the workspace package itself, not a dependency
          'node_modules/glob': { version: '10.5.0' },
        },
      }),
    ]);
    expect(map.has('packages/a')).toBe(false);
    expect(map.get('glob')).toBe('10.5.0');
  });

  it('keeps the LOWEST resolved version when the same package appears in multiple entries (security-conservative)', () => {
    // Mirrors unionNpmDeps policy: a vulnerable resolved version in one
    // workspace must not be hidden by a newer resolution elsewhere.
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/glob': { version: '10.5.0' },            // hoisted (safe)
          'packages/a/node_modules/glob': { version: '10.3.1' }, // workspace-nested (vulnerable)
        },
      }),
    ]);
    // Must keep 10.3.1, NOT hide it behind 10.5.0.
    expect(map.get('glob')).toBe('10.3.1');
  });

  it('keeps the lowest version across MULTIPLE lockfile content strings', () => {
    // Two separate lockfile JSONs (e.g. root lock + per-package lock) that
    // disagree on the resolved version.
    const rootLock = json(lockV3({ lodash: '4.17.21' })); // safe
    const packageLock = json(lockV3({ lodash: '4.14.0' })); // older, potentially vulnerable
    const map = parseNpmLockfileContentsList([rootLock, packageLock]);
    expect(map.get('lodash')).toBe('4.14.0'); // lowest across both
  });

  it('MONOREPO: root lockfile covers a workspace dep under packages/x/node_modules', () => {
    // agent-tasks pattern: root package-lock.json contains workspace-nested
    // entries like `packages/x/node_modules/<dep>`. The parser must find the dep.
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/lodash': { version: '4.17.21' },
          'packages/x/node_modules/lodash': { version: '4.17.21' },
        },
      }),
    ]);
    expect(map.get('lodash')).toBe('4.17.21');
  });

  it('skips malformed JSON entries without throwing, still parses valid ones', () => {
    const map = parseNpmLockfileContentsList([
      '{ bad json',
      json(lockV3({ semver: '7.6.3' })),
    ]);
    expect(map.get('semver')).toBe('7.6.3');
  });

  it('skips entries with no concrete version (non-numeric placeholders)', () => {
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/weird': { version: 'workspace:*' }, // non-concrete
          'node_modules/normal': { version: '1.2.3' },
        },
      }),
    ]);
    expect(map.has('weird')).toBe(false);
    expect(map.get('normal')).toBe('1.2.3');
  });
});
