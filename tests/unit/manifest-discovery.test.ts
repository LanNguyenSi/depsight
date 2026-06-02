import { describe, it, expect } from 'vitest';
import {
  selectManifestPaths,
  pickPrimaryEcosystem,
  unionNpmDeps,
  type TreeEntry,
} from '@/lib/manifest-discovery';

function blob(path: string): TreeEntry {
  return { path, type: 'blob' };
}

describe('selectManifestPaths', () => {
  it('finds workspace + monorepo package.json files', () => {
    // agent-tasks-shaped: workspaces root + member packages.
    const refs = selectManifestPaths([
      blob('package.json'),
      blob('backend/package.json'),
      blob('frontend/package.json'),
      blob('mcp-server/package.json'),
      blob('README.md'),
    ]);
    expect(refs.map((r) => r.path)).toEqual([
      'package.json',
      'backend/package.json',
      'frontend/package.json',
      'mcp-server/package.json',
    ]);
    expect(refs.every((r) => r.ecosystem === 'npm')).toBe(true);
  });

  it('finds packages/* manifests when there is no root manifest', () => {
    // agent-dx-shaped: no root package.json, only packages/*.
    const refs = selectManifestPaths([
      blob('packages/slop-detector/package.json'),
      blob('packages/friction-log/package.json'),
      blob('LICENSE'),
    ]);
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.ecosystem === 'npm')).toBe(true);
  });

  it('excludes vendored / build / fixture directories', () => {
    const refs = selectManifestPaths([
      blob('package.json'),
      blob('node_modules/lodash/package.json'),
      blob('dist/package.json'),
      blob('build/foo/package.json'),
      blob('coverage/package.json'),
      blob('vendor/x/composer.json'),
      blob('tests/fixtures/sample/package.json'),
      blob('examples/demo/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual(['package.json']);
  });

  it('orders shallowest paths first', () => {
    const refs = selectManifestPaths([
      blob('a/b/c/package.json'),
      blob('package.json'),
      blob('a/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual([
      'package.json',
      'a/package.json',
      'a/b/c/package.json',
    ]);
  });

  it('ignores tree entries that are not blobs', () => {
    const refs = selectManifestPaths([
      { path: 'packages', type: 'tree' },
      blob('packages/x/package.json'),
    ]);
    expect(refs.map((r) => r.path)).toEqual(['packages/x/package.json']);
  });
});

describe('pickPrimaryEcosystem', () => {
  it('returns unknown for an empty repo', () => {
    expect(pickPrimaryEcosystem([])).toBe('unknown');
  });

  it('picks npm for a workspaces repo', () => {
    expect(
      pickPrimaryEcosystem([
        { path: 'package.json', ecosystem: 'npm' },
        { path: 'backend/package.json', ecosystem: 'npm' },
      ]),
    ).toBe('npm');
  });

  it('picks npm for a no-root-manifest monorepo', () => {
    expect(
      pickPrimaryEcosystem([
        { path: 'packages/a/package.json', ecosystem: 'npm' },
        { path: 'packages/b/package.json', ecosystem: 'npm' },
      ]),
    ).toBe('npm');
  });

  it('prefers the ecosystem of the shallowest manifest', () => {
    // Root go.mod outranks a nested package.json.
    expect(
      pickPrimaryEcosystem([
        { path: 'go.mod', ecosystem: 'go' },
        { path: 'web/package.json', ecosystem: 'npm' },
      ]),
    ).toBe('go');
  });
});

describe('unionNpmDeps', () => {
  it('unions prod + dev deps across manifests and dedupes by name', () => {
    const deps = unionNpmDeps([
      { name: 'root', dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^1.0.0' } },
      { name: 'pkg-a', dependencies: { react: '^18.2.0', zod: '^3.0.0' } },
    ]);
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(['react', 'vitest', 'zod']);
    // First occurrence wins for the version spec.
    expect(deps.find((d) => d.name === 'react')?.versionSpec).toBe('^18.0.0');
  });

  it('drops workspace-internal references', () => {
    const deps = unionNpmDeps([
      { name: 'pkg-a', dependencies: { 'pkg-b': '^1.0.0', lodash: '^4.0.0' } },
      { name: 'pkg-b', dependencies: {} },
    ]);
    expect(deps.map((d) => d.name)).toEqual(['lodash']);
  });

  it('promotes a dep from dev to prod when seen as a runtime dep anywhere', () => {
    const deps = unionNpmDeps([
      { name: 'a', devDependencies: { typescript: '^5.0.0' } },
      { name: 'b', dependencies: { typescript: '^5.1.0' } },
    ]);
    const ts = deps.find((d) => d.name === 'typescript');
    expect(ts?.isDev).toBe(false);
  });

  it('handles manifests with no deps (workspaces orchestration root)', () => {
    const deps = unionNpmDeps([{ name: 'agent-tasks' }]);
    expect(deps).toEqual([]);
  });
});
