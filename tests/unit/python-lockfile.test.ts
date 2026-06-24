/**
 * Unit tests for the pure Python lockfile helpers in lib/manifests/python.ts.
 *
 * Both parsePythonLockfileContents and discoverPythonLockfilePaths are
 * synchronous and have no I/O, so no mocks are needed.
 * The I/O wrapper (fetchPythonLockfileResolutions) and its end-to-end wiring
 * into collectDeps are covered by tests/unit/osv-lockfile.test.ts.
 *
 * normalizePythonPackageName:
 *   - lowercases the name
 *   - collapses runs of underscore/dot/hyphen to a single hyphen
 *
 * discoverPythonLockfilePaths:
 *   - always includes repo-root uv.lock and poetry.lock
 *   - includes co-located lockfiles next to each non-root manifest
 *   - deduplicates (root manifest → no duplicate root lockfile entries)
 *   - handles deep monorepo paths
 *
 * parsePythonLockfileContents:
 *   - uv.lock [[package]] block parse
 *   - poetry.lock [[package]] block parse (identical shape)
 *   - multiple packages in one content string
 *   - lowest-version-wins across duplicate entries (security-conservative)
 *   - lowest-version-wins across multiple content strings
 *   - underscore ↔ hyphen normalization: stored under canonical form
 *   - malformed/partial block (missing name or version) silently skipped
 *   - empty content list → empty map
 */

import { describe, it, expect } from 'vitest';

import {
  normalizePythonPackageName,
  discoverPythonLockfilePaths,
  parsePythonLockfileContents,
} from '@/lib/manifests/python';

// ---- Helpers ----------------------------------------------------------------

/** Build a minimal uv.lock / poetry.lock content with the given packages. */
function uvLock(packages: Array<{ name: string; version: string }>): string {
  return packages
    .map(
      ({ name, version }) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\n`,
    )
    .join('\n');
}

// ============================================================================
// normalizePythonPackageName
// ============================================================================

describe('normalizePythonPackageName', () => {
  it('lowercases the name', () => {
    expect(normalizePythonPackageName('Jinja2')).toBe('jinja2');
    expect(normalizePythonPackageName('Pillow')).toBe('pillow');
  });

  it('replaces underscores with hyphens (PEP 503)', () => {
    expect(normalizePythonPackageName('my_package')).toBe('my-package');
  });

  it('replaces dots with hyphens (PEP 503)', () => {
    expect(normalizePythonPackageName('zope.interface')).toBe('zope-interface');
  });

  it('collapses multiple separators to a single hyphen', () => {
    expect(normalizePythonPackageName('my__pkg')).toBe('my-pkg');
    expect(normalizePythonPackageName('my._pkg')).toBe('my-pkg');
    expect(normalizePythonPackageName('my--pkg')).toBe('my-pkg');
  });

  it('leaves already-canonical names unchanged', () => {
    expect(normalizePythonPackageName('requests')).toBe('requests');
    expect(normalizePythonPackageName('flask')).toBe('flask');
    expect(normalizePythonPackageName('jinja2')).toBe('jinja2');
  });
});

// ============================================================================
// discoverPythonLockfilePaths
// ============================================================================

describe('discoverPythonLockfilePaths', () => {
  it('always includes repo-root uv.lock and poetry.lock', () => {
    const paths = discoverPythonLockfilePaths([]);
    expect(paths).toContain('uv.lock');
    expect(paths).toContain('poetry.lock');
  });

  it('deduplicates when manifest is at the root (same as root lockfiles)', () => {
    const paths = discoverPythonLockfilePaths(['pyproject.toml']);
    // Root manifest: no additional co-located entries beyond the root lockfiles
    expect(paths).toContain('uv.lock');
    expect(paths).toContain('poetry.lock');
    // Exactly root-level files only (no duplicates)
    expect(paths.filter((p) => p === 'uv.lock')).toHaveLength(1);
    expect(paths.filter((p) => p === 'poetry.lock')).toHaveLength(1);
  });

  it('adds co-located lockfiles for a non-root manifest', () => {
    const paths = discoverPythonLockfilePaths(['services/api/pyproject.toml']);
    expect(paths).toContain('uv.lock');
    expect(paths).toContain('poetry.lock');
    expect(paths).toContain('services/api/uv.lock');
    expect(paths).toContain('services/api/poetry.lock');
    expect(paths).toHaveLength(4);
  });

  it('handles multiple manifests and deduplicates across them', () => {
    const paths = discoverPythonLockfilePaths([
      'pyproject.toml',
      'svc/pyproject.toml',
      'svc/requirements.txt', // same directory as previous → no new lockfile paths
    ]);
    expect(paths).toContain('uv.lock');
    expect(paths).toContain('poetry.lock');
    expect(paths).toContain('svc/uv.lock');
    expect(paths).toContain('svc/poetry.lock');
    // root (2) + svc (2) = 4 unique paths
    expect(paths).toHaveLength(4);
  });
});

// ============================================================================
// parsePythonLockfileContents
// ============================================================================

describe('parsePythonLockfileContents', () => {
  it('returns an empty map for an empty content list', () => {
    expect(parsePythonLockfileContents([])).toEqual(new Map());
  });

  it('parses a uv.lock [[package]] block and returns the resolved version', () => {
    const content = uvLock([{ name: 'jinja2', version: '3.1.6' }]);
    const map = parsePythonLockfileContents([content]);
    expect(map.get('jinja2')).toBe('3.1.6');
  });

  it('parses a poetry.lock [[package]] block (identical [[package]] shape)', () => {
    // poetry.lock uses exactly the same [[package]] block structure as uv.lock
    const content = [
      '[[package]]',
      'name = "requests"',
      'version = "2.32.3"',
      'description = "Python HTTP for Humans."',
      'category = "main"',
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    expect(map.get('requests')).toBe('2.32.3');
  });

  it('parses multiple [[package]] blocks in one content string', () => {
    const content = uvLock([
      { name: 'jinja2', version: '3.1.6' },
      { name: 'pydantic', version: '2.13.4' },
      { name: 'requests', version: '2.32.3' },
    ]);
    const map = parsePythonLockfileContents([content]);
    expect(map.get('jinja2')).toBe('3.1.6');
    expect(map.get('pydantic')).toBe('2.13.4');
    expect(map.get('requests')).toBe('2.32.3');
    expect(map.size).toBe(3);
  });

  it('keeps the LOWEST resolved version when the same package appears multiple times (security-conservative)', () => {
    // Two entries in the same lockfile for jinja2 (e.g. different optional deps)
    const content = [
      '[[package]]',
      'name = "jinja2"',
      'version = "3.1.6"',
      '',
      '[[package]]',
      'name = "jinja2"',
      'version = "3.0.1"', // older, potentially vulnerable
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    // Must keep 3.0.1, NOT hide it behind 3.1.6
    expect(map.get('jinja2')).toBe('3.0.1');
  });

  it('keeps the lowest version across MULTIPLE content strings (uv.lock + poetry.lock)', () => {
    const uvContent = uvLock([{ name: 'jinja2', version: '3.1.6' }]); // safe
    const poetryContent = [
      '[[package]]',
      'name = "jinja2"',
      'version = "3.1.2"', // older, potentially vulnerable
    ].join('\n');
    const map = parsePythonLockfileContents([uvContent, poetryContent]);
    // Lowest across both files
    expect(map.get('jinja2')).toBe('3.1.2');
  });

  it('normalizes underscore names: my_package stored under my-package key', () => {
    const content = [
      '[[package]]',
      'name = "my_package"',
      'version = "1.2.3"',
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    // Stored under canonical form
    expect(map.has('my_package')).toBe(false);
    expect(map.get('my-package')).toBe('1.2.3');
  });

  it('normalizes hyphen/underscore/dot variants to the same canonical key', () => {
    // A lockfile might use "Jinja2" while pyproject uses "jinja2"; both must hit the same key
    const content = [
      '[[package]]',
      'name = "Jinja2"',
      'version = "3.1.6"',
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    expect(map.get('jinja2')).toBe('3.1.6');
  });

  it('silently skips a partial block missing the version field', () => {
    const content = [
      '[[package]]',
      'name = "incomplete"',
      // no version line
      '',
      '[[package]]',
      'name = "complete"',
      'version = "1.0.0"',
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    expect(map.has('incomplete')).toBe(false);
    expect(map.get('complete')).toBe('1.0.0');
  });

  it('silently skips a partial block missing the name field', () => {
    const content = [
      '[[package]]',
      'version = "1.0.0"',
      // no name line
      '',
      '[[package]]',
      'name = "complete"',
      'version = "2.0.0"',
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    expect(map.size).toBe(1);
    expect(map.get('complete')).toBe('2.0.0');
  });

  it('handles extra fields between name and version without confusion', () => {
    const content = [
      '[[package]]',
      'name = "pydantic"',
      'description = "Data validation using Python type hints"',
      'optional = false',
      'version = "2.13.4"',
      'python-versions = ">=3.8"',
    ].join('\n');
    const map = parsePythonLockfileContents([content]);
    expect(map.get('pydantic')).toBe('2.13.4');
  });

  it('skips content with no [[package]] blocks (empty map)', () => {
    const content = '# This is a lockfile header\n\n[metadata]\ncontent-hash = "abc"\n';
    const map = parsePythonLockfileContents([content]);
    expect(map.size).toBe(0);
  });
});
