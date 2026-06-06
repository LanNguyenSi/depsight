import { describe, it, expect, vi } from 'vitest';

import { collectPythonDeps } from '@/lib/manifests/python';
import { collectGoDeps, parseGoModuleName } from '@/lib/manifests/go';
import { collectJavaDeps } from '@/lib/manifests/java';
import { collectRustDeps } from '@/lib/manifests/rust';
import { collectPhpDeps } from '@/lib/manifests/php';

type Octokit = Parameters<typeof collectPythonDeps>[0];

/**
 * Build a fake octokit whose repos.getContent returns the base64-encoded text
 * for known paths and throws (404) for everything else — mirroring how the
 * GitHub Contents API behaves for missing files.
 */
function octokitWith(files: Record<string, string>): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path in files) {
      return { data: { content: Buffer.from(files[path]).toString('base64') } };
    }
    throw new Error('404');
  });
  return { rest: { repos: { getContent } } } as unknown as Octokit;
}

describe('collectPythonDeps', () => {
  it('unions deps across multiple manifests (monorepo)', async () => {
    const oct = octokitWith({
      'requirements.txt': 'flask==2.0.0\n',
      'svc/requirements.txt': 'requests>=2.28\ndjango==4.0\n',
    });
    const deps = await collectPythonDeps(oct, 'o', 'r', ['requirements.txt', 'svc/requirements.txt']);
    expect(deps.map((d) => d.name).sort()).toEqual(['django', 'flask', 'requests']);
  });

  it('collapses a cross-module version conflict to the first-seen (root-first) spec', async () => {
    const oct = octokitWith({
      'pyproject.toml': 'dependencies = ["requests==2.0.0"]',
      'mod/requirements.txt': 'requests==1.0.0\n',
    });
    const deps = await collectPythonDeps(oct, 'o', 'r', ['pyproject.toml', 'mod/requirements.txt']);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({ name: 'requests', version: '2.0.0' });
  });

  it('leaves a single-root repo unchanged', async () => {
    const oct = octokitWith({ 'requirements.txt': 'flask==2.0.0\n' });
    const deps = await collectPythonDeps(oct, 'o', 'r', ['requirements.txt']);
    expect(deps).toEqual([{ name: 'flask', version: '2.0.0' }]);
  });

  it('prefers pyproject.toml over requirements.txt in the same directory (no double-count)', async () => {
    // requirements.txt is often a pip-freeze of the full transitive tree; when a
    // directory also has a pyproject.toml the requirements.txt must be ignored,
    // matching legacy precedence so single-root output is unchanged.
    const oct = octokitWith({
      'pyproject.toml': 'dependencies = ["flask==2.0.0"]',
      'requirements.txt': 'flask==2.0.0\nfrozen-transitive==9.9.9\n',
    });
    const deps = await collectPythonDeps(oct, 'o', 'r', ['pyproject.toml', 'requirements.txt']);
    expect(deps).toEqual([{ name: 'flask', version: '2.0.0' }]);
  });

  it('falls back to requirements.txt when same-dir pyproject declares no dependencies (poetry-style)', async () => {
    const oct = octokitWith({
      'pyproject.toml': '[tool.poetry]\nname = "x"\n',
      'requirements.txt': 'requests==1.0.0\n',
    });
    const deps = await collectPythonDeps(oct, 'o', 'r', ['pyproject.toml', 'requirements.txt']);
    expect(deps).toEqual([{ name: 'requests', version: '1.0.0' }]);
  });

  it('falls back to root manifests when no paths are supplied', async () => {
    const oct = octokitWith({ 'requirements.txt': 'numpy==1.0\n' });
    const deps = await collectPythonDeps(oct, 'o', 'r');
    expect(deps).toEqual([{ name: 'numpy', version: '1.0' }]);
  });
});

describe('collectGoDeps', () => {
  const rootMod = `module example.com/repo

go 1.21

require (
\tgithub.com/pkg/errors v0.9.1
\texample.com/repo/sub v0.0.0
)
`;
  const subMod = `module example.com/repo/sub

go 1.21

require github.com/sirupsen/logrus v1.9.0
`;

  it('unions requires across modules and drops repo-local modules', async () => {
    const oct = octokitWith({ 'go.mod': rootMod, 'sub/go.mod': subMod });
    const deps = await collectGoDeps(oct, 'o', 'r', ['go.mod', 'sub/go.mod']);
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(['github.com/pkg/errors', 'github.com/sirupsen/logrus']);
    // The sibling module example.com/repo/sub is required by root but is itself
    // a repo-local module → filtered out.
    expect(names).not.toContain('example.com/repo/sub');
  });

  it('skips unreadable manifests and leaves a single-root repo unchanged', async () => {
    const oct = octokitWith({ 'go.mod': subMod });
    const deps = await collectGoDeps(oct, 'o', 'r', ['go.mod', 'missing/go.mod']);
    expect(deps).toEqual([{ name: 'github.com/sirupsen/logrus', version: 'v1.9.0' }]);
  });
});

describe('parseGoModuleName', () => {
  it('extracts the module path', () => {
    expect(parseGoModuleName('module example.com/foo\n\ngo 1.21')).toBe('example.com/foo');
  });
  it('returns null when no module directive is present', () => {
    expect(parseGoModuleName('go 1.21\n')).toBeNull();
  });
});

describe('collectJavaDeps', () => {
  const rootPom = `<project><dependencies>
    <dependency><groupId>org.foo</groupId><artifactId>a</artifactId><version>1.0</version></dependency>
  </dependencies></project>`;
  const modPom = `<project><dependencies>
    <dependency><groupId>org.foo</groupId><artifactId>a</artifactId><version>2.0</version></dependency>
    <dependency><groupId>org.bar</groupId><artifactId>b</artifactId><version>3.0</version></dependency>
  </dependencies></project>`;

  it('unions deps across reactor modules, deduping by groupId:artifactId', async () => {
    const oct = octokitWith({ 'pom.xml': rootPom, 'mod/pom.xml': modPom });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['pom.xml', 'mod/pom.xml']);
    expect(deps.map((d) => `${d.groupId}:${d.artifactId}`).sort()).toEqual(['org.bar:b', 'org.foo:a']);
    // First-seen (root pom) wins the version.
    expect(deps.find((d) => d.artifactId === 'a')?.version).toBe('1.0');
  });

  it('leaves a single-root repo unchanged', async () => {
    const oct = octokitWith({ 'pom.xml': rootPom });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['pom.xml']);
    expect(deps).toEqual([{ groupId: 'org.foo', artifactId: 'a', version: '1.0' }]);
  });

  it('resolves child versions from a parent dependencyManagement', async () => {
    const parent = `<project>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>org.foo</groupId><artifactId>lib</artifactId><version>2.5.0</version></dependency>
    </dependencies>
  </dependencyManagement>
</project>`;
    const child = `<project>
  <dependencies>
    <dependency><groupId>org.foo</groupId><artifactId>lib</artifactId></dependency>
    <dependency><groupId>org.bar</groupId><artifactId>util</artifactId><version>1.0</version></dependency>
  </dependencies>
</project>`;
    const oct = octokitWith({ 'pom.xml': parent, 'svc/pom.xml': child });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['pom.xml', 'svc/pom.xml']);
    const versions = Object.fromEntries(deps.map((d) => [`${d.groupId}:${d.artifactId}`, d.version]));
    expect(versions).toEqual({ 'org.foo:lib': '2.5.0', 'org.bar:util': '1.0' });
  });

  it('skips a versionless dependency that no dependencyManagement covers', async () => {
    const pom = `<project><dependencies>
    <dependency><groupId>org.x</groupId><artifactId>y</artifactId></dependency>
    <dependency><groupId>org.z</groupId><artifactId>w</artifactId><version>3.0</version></dependency>
  </dependencies></project>`;
    const oct = octokitWith({ 'pom.xml': pom });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['pom.xml']);
    expect(deps).toEqual([{ groupId: 'org.z', artifactId: 'w', version: '3.0' }]);
  });

  it('does not count managed-but-unused dependencyManagement entries as deps', async () => {
    // Only org.managed:used is actually depended on; the BOM-style unused
    // managed entry must not surface as an installed dependency.
    const pom = `<project>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>org.managed</groupId><artifactId>used</artifactId><version>1.0</version></dependency>
      <dependency><groupId>org.managed</groupId><artifactId>unused</artifactId><version>9.9</version><type>pom</type><scope>import</scope></dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency><groupId>org.managed</groupId><artifactId>used</artifactId></dependency>
  </dependencies>
</project>`;
    const oct = octokitWith({ 'pom.xml': pom });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['pom.xml']);
    expect(deps).toEqual([{ groupId: 'org.managed', artifactId: 'used', version: '1.0' }]);
  });
});

describe('collectRustDeps', () => {
  const rootCargo = `[workspace]
members = ["crate-a", "crate-b"]
`;
  const crateA = `[package]
name = "crate-a"
[dependencies]
serde = "1.0"
`;
  const crateB = `[package]
name = "crate-b"
[dependencies]
serde = "1.1"
tokio = { version = "1", features = ["full"] }
`;

  it('unions member-crate deps while the virtual workspace root contributes nothing', async () => {
    const oct = octokitWith({
      'Cargo.toml': rootCargo,
      'crate-a/Cargo.toml': crateA,
      'crate-b/Cargo.toml': crateB,
    });
    const deps = await collectRustDeps(oct, 'o', 'r', [
      'Cargo.toml',
      'crate-a/Cargo.toml',
      'crate-b/Cargo.toml',
    ]);
    expect(deps.map((d) => d.name).sort()).toEqual(['serde', 'tokio']);
    // crate-a is read before crate-b → its serde spec wins.
    expect(deps.find((d) => d.name === 'serde')?.version).toBe('1.0');
  });

  it('resolves workspace dependency inheritance (workspace = true)', async () => {
    const wsRoot = `[workspace]
members = ["crate-a"]

[workspace.dependencies]
serde = "1.0.195"
tokio = { version = "1.35", features = ["full"] }
`;
    const member = `[package]
name = "crate-a"

[dependencies]
serde = { workspace = true }
tokio = { workspace = true, features = ["macros"] }
anyhow = "1.0"
`;
    const oct = octokitWith({ 'Cargo.toml': wsRoot, 'crate-a/Cargo.toml': member });
    const deps = await collectRustDeps(oct, 'o', 'r', ['Cargo.toml', 'crate-a/Cargo.toml']);
    const versions = Object.fromEntries(deps.map((d) => [d.name, d.version]));
    expect(versions).toEqual({ serde: '1.0.195', tokio: '1.35', anyhow: '1.0' });
  });

  it('resolves the dotted-key inherit form (serde.workspace = true)', async () => {
    const wsRoot = `[workspace]
members = ["crate-a"]

[workspace.dependencies]
serde = "1.0.195"
`;
    const member = `[package]
name = "crate-a"

[dependencies]
serde.workspace = true
anyhow = "1.0"
`;
    const oct = octokitWith({ 'Cargo.toml': wsRoot, 'crate-a/Cargo.toml': member });
    const deps = await collectRustDeps(oct, 'o', 'r', ['Cargo.toml', 'crate-a/Cargo.toml']);
    const versions = Object.fromEntries(deps.map((d) => [d.name, d.version]));
    expect(versions).toEqual({ serde: '1.0.195', anyhow: '1.0' });
  });

  it('leaves a single non-workspace crate unchanged', async () => {
    const cargo = `[package]
name = "solo"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }
`;
    const oct = octokitWith({ 'Cargo.toml': cargo });
    const deps = await collectRustDeps(oct, 'o', 'r', ['Cargo.toml']);
    expect(deps).toEqual([
      { name: 'serde', version: '1.0' },
      { name: 'tokio', version: '1.35' },
    ]);
  });

  it('keeps an empty version when a workspace-inherited dep is absent from the table', async () => {
    const wsRoot = `[workspace]
members = ["crate-a"]

[workspace.dependencies]
serde = "1.0.195"
`;
    const member = `[package]
name = "crate-a"

[dependencies]
serde = { workspace = true }
mystery = { workspace = true }
`;
    const oct = octokitWith({ 'Cargo.toml': wsRoot, 'crate-a/Cargo.toml': member });
    const deps = await collectRustDeps(oct, 'o', 'r', ['Cargo.toml', 'crate-a/Cargo.toml']);
    const versions = Object.fromEntries(deps.map((d) => [d.name, d.version]));
    expect(versions).toEqual({ serde: '1.0.195', mystery: '' });
  });
});

describe('collectPhpDeps', () => {
  it('unions require blocks across composer manifests and skips php/ext entries', async () => {
    const oct = octokitWith({
      'composer.json': JSON.stringify({ require: { 'monolog/monolog': '^2.0', php: '>=8.0' } }),
      'pkg/composer.json': JSON.stringify({ require: { 'monolog/monolog': '^3.0', 'guzzlehttp/guzzle': '^7.0' } }),
    });
    const deps = await collectPhpDeps(oct, 'o', 'r', ['composer.json', 'pkg/composer.json']);
    expect(deps.map((d) => d.name).sort()).toEqual(['guzzlehttp/guzzle', 'monolog/monolog']);
    // First-seen (root) wins; version constraint is stripped to its base.
    expect(deps.find((d) => d.name === 'monolog/monolog')?.version).toBe('2.0');
  });
});
