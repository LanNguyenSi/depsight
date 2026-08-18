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
 *   - a name resolving to the SAME version across multiple entries is kept
 *   - a name resolving to DISTINCT versions across entries is dropped entirely
 *     (D-006: ambiguity degrades to the manifest floor, not lowest-wins —
 *     task 18f6c239, aligning this parser with parseYarnLockfileContentsList)
 *   - NEGATIVE CONTROL: an unambiguous resolved-vulnerable package stays flagged
 *   - empty list → empty map
 *   - malformed JSON entry → silently skipped, other entries still parsed
 *   - MONOREPO: root lockfile entry covers a workspace dep (agreeing versions)
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

  it('keeps a resolved version when the same package appears in multiple entries agreeing on the same version', () => {
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/glob': { version: '10.5.0' },
          'packages/a/node_modules/glob': { version: '10.5.0' },
        },
      }),
    ]);
    expect(map.get('glob')).toBe('10.5.0');
  });

  it('D-006: drops a name entirely when a direct dep and a nested transitive resolve to DISTINCT versions (floor fallback, not lowest-wins)', () => {
    // A real scenario a keyed-by-bare-name map can't disambiguate: the
    // manifest declares glob@^10.3.0 directly, but an unrelated nested
    // transitive under a different package's tree also pins glob, at a lower
    // major (^7.x), resolved to 7.2.3. A naive lowest-wins map would silently
    // report glob as resolved to 7.2.3 (an unrelated package's resolution),
    // which is a FALSE NEGATIVE for any CVE affecting the real (10.x)
    // installed glob. The fix: when a bare name has more than one distinct
    // resolved version, drop it from the map so the caller falls back to the
    // manifest floor (10.3.0) instead — the finding is NOT falsely cleared.
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/glob': { version: '10.4.0' },                      // direct dep
          'node_modules/foreground-child/node_modules/glob': { version: '7.2.3' }, // unrelated nested transitive
        },
      }),
    ]);
    expect(map.has('glob')).toBe(false);
  });

  it('D-006 self-scan regression (task 18f6c239): a direct floor pin is not shadowed by a lower nested transitive of the same name', () => {
    // Reproduces the concrete false negative measured on depsight's own
    // package-lock.json: semver is declared ^7.8.5, but the lockfile also
    // carries a nested semver@6.3.1 from an unrelated transitive tree. The
    // old lowest-wins map queried OSV at 6.3.1 instead of the manifest floor
    // 7.8.5, hiding advisories that only affect 7.x.
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/semver': { version: '7.8.5' },
          'node_modules/some-dep/node_modules/semver': { version: '6.3.1' },
        },
      }),
    ]);
    expect(map.has('semver')).toBe(false);
  });

  it('D-006: distinct-version drop also applies across MULTIPLE lockfile content strings', () => {
    const rootLock = json(lockV3({ lodash: '4.17.21' }));
    const packageLock = json(lockV3({ lodash: '4.14.0' }));
    const map = parseNpmLockfileContentsList([rootLock, packageLock]);
    expect(map.has('lodash')).toBe(false);
  });

  it('D-006: a conflicted name STAYS dropped even when a third entry re-agrees with the first value ([A,B,A])', () => {
    // Without the sticky `conflicted` set, the third entry would re-insert
    // the name after the delete, resurrecting exactly the ambiguous
    // resolution D-006 forbids.
    const map = parseNpmLockfileContentsList([
      json({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/glob': { version: '10.4.0' },
          'node_modules/a/node_modules/glob': { version: '7.2.3' },
          'node_modules/b/node_modules/glob': { version: '10.4.0' },
        },
      }),
    ]);
    expect(map.has('glob')).toBe(false);
  });

  it('NEGATIVE CONTROL: an unambiguous resolved-vulnerable package (single distinct version in the lockfile) stays flagged', () => {
    // Guards against an overzealous fix that drops everything: a genuinely
    // single-resolution, vulnerable package must still surface its real
    // version for OSV querying, whether it appears once or is repeated with
    // full agreement across multiple entries/content strings.
    const rootLock = json(lockV3({ lodash: '4.14.0' })); // vulnerable, unambiguous
    const packageLock = json(lockV3({ lodash: '4.14.0' })); // same resolution, agrees
    const map = parseNpmLockfileContentsList([rootLock, packageLock]);
    expect(map.get('lodash')).toBe('4.14.0');
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
