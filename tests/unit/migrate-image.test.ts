// The production schema step (the `migrate` service of docker-compose.traefik.yml, run by the
// .relay.yml post_update hook, which builds it after the pull) must run the Prisma CLI that
// package-lock.json pins, from an image built with the app, and must fetch nothing when it
// runs. A step that downloads a `prisma@<pin>` of its own drifts from the app's @prisma/client
// 6 and needs outbound network on a database network that has none.
//
// These tests read the shipped files as text (no docker needed); the build and a run against
// a real Postgres are covered by the deploy-path test in advisory-dedupe-db.test.ts and by the
// guard script.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import semver from 'semver';

const ROOT = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const HOSTED_FILE = 'docker-compose.traefik.yml';

/** The body of the `migrate` service block (indented lines up to the next top-level entry). */
function migrateBlock(): string {
  const match = read(HOSTED_FILE).match(/^ {2}migrate:\n((?: {4}.*\n| *\n)+)/m);
  expect(match, `${HOSTED_FILE} has a migrate service`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

/** Non-comment lines of a block, so a comment that names a forbidden thing does not count. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The stages of the Dockerfile in file order: name and the text of each stage. */
function dockerStages(): Array<{ name: string; body: string }> {
  const text = read('Dockerfile');
  const starts = [...text.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gim)];
  expect(starts.length).toBeGreaterThan(0);
  return starts.map((m, i) => ({
    name: m[1],
    body: text.slice(m.index as number, i + 1 < starts.length ? (starts[i + 1].index as number) : undefined),
  }));
}

const stage = (name: string) => {
  const found = dockerStages().find((s) => s.name === name);
  expect(found, `Dockerfile has a stage "${name}"`).toBeDefined();
  return found as { name: string; body: string };
};

describe('migrate service uses the repo build', () => {
  it('builds target migrate of this repo Dockerfile and names no image of its own', () => {
    const block = code(migrateBlock());
    expect(block).toMatch(/^ {4}build:\n {6}context: \.\n {6}dockerfile: Dockerfile\n {6}target: migrate\n/m);
    // `image: node:20-slim` was the old step: a stock image with nothing of the lockfile in it.
    expect(block).not.toMatch(/^ {4}image:/m);
  });

  it('runs the CLI of the image: no version pin, no npx, no fetch at run time', () => {
    const block = code(migrateBlock());
    expect(block).not.toMatch(/prisma@/);
    expect(block).not.toMatch(/\bnpx\b/);
    expect(block).not.toMatch(/\bnpm\b/);
    expect(block).not.toMatch(/apt-get|apt\b/);
    // The schema and SQL are in the image; a bind mount would run the host's copy instead.
    expect(block).not.toMatch(/^ {4}volumes:/m);
  });

  it('joins only the private database network, which has no route out', () => {
    const block = code(migrateBlock());
    const networks = block.match(/^ {4}networks:\n((?: {6}- .*\n)+)/m);
    expect(networks, 'migrate lists its networks').not.toBeNull();
    expect((networks as RegExpMatchArray)[1].trim().split('\n').map((l) => l.replace(/^\s*-\s*/, ''))).toEqual([
      'db-internal',
    ]);
  });

  // The relay runs pre_update on the tree from BEFORE the pull, its own post-pull build is a plain
  // `build` (a profile-scoped service is skipped), and `compose run` reuses an existing image.
  // Only a build inside post_update sees the pulled schema.
  const hookItems = (name: 'pre_update' | 'post_update') => {
    const hook = read('.relay.yml').match(new RegExp(`^${name}:\\s*\\n((?:\\s+-.*\\n?)+)`, 'm'));
    expect(hook, `.relay.yml has a ${name} list`).not.toBeNull();
    return (hook as RegExpMatchArray)[1]
      .split('\n')
      .filter((line) => /^\s+-\s/.test(line))
      .map((line) => line.replace(/^\s+-\s+/, '').trim());
  };
  const BUILDS_MIGRATE = new RegExp(
    `^docker compose -f ${HOSTED_FILE.replace(/\./g, '\\.')} (?:run\\b.*--build\\b.*\\bmigrate$|--profile tools build\\b)`,
  );

  it('post_update builds migrate from the pulled tree and runs it', () => {
    const items = hookItems('post_update');
    // One step, so no ordering between a build and a run can come apart: `run --build` rebuilds
    // from the post-pull tree (layer cache) and then runs that image.
    expect(items).toEqual([`docker compose -f ${HOSTED_FILE} run --rm -T --build migrate`]);
    expect(items.some((item) => BUILDS_MIGRATE.test(item))).toBe(true);
    // The profile is what keeps `up` and the plain `build` from selecting it.
    expect(migrateBlock()).toMatch(/^ {4}profiles: \["tools"\]$/m);
  });

  it('pre_update does not build migrate: it runs on the pre-pull tree and would bake in the old schema', () => {
    const items = hookItems('pre_update');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item, item).not.toMatch(/--profile\b/);
      expect(item, item).not.toMatch(/\bmigrate\b/);
      expect(item, item).not.toMatch(/--build\b/);
    }
    expect(items.some((item) => BUILDS_MIGRATE.test(item))).toBe(false);
  });
});

describe('migrate image stage', () => {
  it('takes the CLI from the migrate-cli stage and the schema from the checkout, not the whole install', () => {
    const deps = stage('deps').body;
    expect(deps).toMatch(/COPY package\.json package-lock\.json \.\/\n/);
    expect(deps).toMatch(/^RUN npm ci$/m);
    const migrate = stage('migrate').body;
    // The old stage copied the deps stage's node_modules (dev dependencies included, ~1.5 GB).
    expect(code(migrate)).not.toMatch(/COPY --from=deps\b/);
    expect(migrate).toMatch(/^COPY --from=migrate-cli \/out\/node_modules \.\/node_modules$/m);
    expect(migrate).toMatch(/^COPY prisma \.\/prisma\/$/m);
    // The CLI is found in node_modules/.bin, not downloaded.
    expect(migrate).toMatch(/^ENV PATH="\/app\/node_modules\/\.bin:\$\{PATH\}"$/m);
  });

  it('builds the CLI tree from the deps stage, so the version is the lockfile install', () => {
    const cli = stage('migrate-cli').body;
    expect(cli).toMatch(/^FROM deps AS migrate-cli$/m);
    // Nothing is installed or resolved again: a second install could pick another version.
    expect(code(cli)).not.toMatch(/\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b|apt-get/);
    // It starts from the installed `prisma` and the symlink points at the real CLI entry.
    expect(cli).toMatch(/find\("prisma", root\)/);
    expect(cli).toMatch(/^ln -s \.\.\/prisma\/build\/index\.js \/out\/node_modules\/\.bin\/prisma$/m);
    expect(existsSync(join(ROOT, 'node_modules/prisma/build/index.js'))).toBe(true);
  });

  it('prunes only files the CLI never loads', () => {
    const cli = stage('migrate-cli').body;
    expect(cli).toMatch(
      /^find \/out\/node_modules -type f \\\( -name '\*\.map' -o -name '\*\.d\.ts' -o -name '\*\.d\.mts' -o -name '\*\.d\.cts' \\\) -delete$/m,
    );
    expect(cli).toMatch(/^rm -rf \/out\/node_modules\/effect\/src$/m);
    // Engines, wasm and anything else is kept: the schema step runs offline.
    const deletions = cli.split('\n').filter((line) => /-delete|\brm\b/.test(line));
    expect(deletions).toHaveLength(2);
  });

  it('smoke-tests the CLI at build time, so a broken tree fails the build and not the deploy', () => {
    const migrate = stage('migrate').body;
    expect(migrate).toMatch(/^RUN CHECKPOINT_DISABLE=1 prisma --version$/m);
    // After the schema copy and before the switch to the non-root user.
    expect(migrate.indexOf('prisma --version')).toBeGreaterThan(migrate.indexOf('COPY prisma ./prisma/'));
    expect(migrate.indexOf('prisma --version')).toBeLessThan(migrate.indexOf('USER node'));
  });

  it('runs as the non-root node user', () => {
    expect(stage('migrate').body).toMatch(/^USER node$/m);
  });

  it('installs openssl at build time and runs no package fetch of its own', () => {
    const body = code(stage('migrate').body);
    expect(body).toMatch(/apt-get install -y openssl/);
    expect(body).not.toMatch(/\bnpm (install|i|ci|exec)\b|\bnpx\b/);
  });

  it('is not the last stage, so the app image keeps building the runner by default', () => {
    const names = dockerStages().map((s) => s.name);
    expect(names).toContain('migrate');
    expect(names[names.length - 1]).toBe('runner');
  });
});

// The dependency-closure script of the migrate-cli stage is run here as the build runs it:
// extracted from the Dockerfile, with the installed tree directory as its argument.
describe('migrate-cli closure script', () => {
  const script = () => {
    const match = stage('migrate-cli').body.match(/<<'JS'\n([\s\S]*?)\nJS\n/);
    expect(match, 'migrate-cli carries the closure script').not.toBeNull();
    return (match as RegExpMatchArray)[1];
  };
  const runScript = (root: string) => {
    try {
      const stdout = execFileSync(process.execPath, ['--max-old-space-size=128', '-', root], {
        input: script(),
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, lines: stdout.split('\n').filter(Boolean), stderr: '' };
    } catch (err) {
      const e = err as { stderr?: string };
      return { ok: false, lines: [] as string[], stderr: e.stderr ?? '' };
    }
  };

  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  /** A node_modules tree: path (below the root) -> package.json content. */
  const tree = (packages: Record<string, object>) => {
    const root = mkdtempSync(join(tmpdir(), 'migrate-cli-'));
    dirs.push(root);
    for (const [path, pkg] of Object.entries(packages)) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, 'package.json'), JSON.stringify(pkg));
    }
    return root;
  };
  const pkg = (name: string, extra: object = {}) => ({ name, version: '1.0.0', ...extra });

  it('lists prisma and the packages reachable through dependencies, sorted, and nothing else', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { dependencies: { a: '1' } }),
      'node_modules/a': pkg('a', { dependencies: { b: '1' } }),
      'node_modules/b': pkg('b'),
      'node_modules/unrelated': pkg('unrelated'),
    });
    const result = runScript(root);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.lines).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/prisma']);
  });

  it('follows optionalDependencies that are installed and skips those that are not', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { optionalDependencies: { present: '1', absent: '1' } }),
      'node_modules/present': pkg('present'),
    });
    const result = runScript(root);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.lines).toEqual(['node_modules/present', 'node_modules/prisma']);
  });

  it('does not follow devDependencies or peerDependencies', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { devDependencies: { dev: '1' }, peerDependencies: { peer: '1' } }),
      'node_modules/dev': pkg('dev'),
      'node_modules/peer': pkg('peer'),
    });
    expect(runScript(root).lines).toEqual(['node_modules/prisma']);
  });

  it('fails when a required dependency is not installed, naming it', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { dependencies: { gone: '1' } }),
    });
    const result = runScript(root);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/prisma needs gone, which is not installed/);
  });

  it('fails when prisma itself is not installed', () => {
    const result = runScript(tree({ 'node_modules/other': pkg('other') }));
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/prisma is not installed/);
  });

  it('resolves a dependency the way Node does: the nested copy nearest the requirer wins', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { dependencies: { a: '1', shared: '1' } }),
      'node_modules/a': pkg('a', { dependencies: { shared: '2' } }),
      'node_modules/a/node_modules/shared': pkg('shared', { version: '2.0.0' }),
      'node_modules/shared': pkg('shared', { version: '1.0.0' }),
    });
    const result = runScript(root);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.lines).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/shared',
      'node_modules/prisma',
      'node_modules/shared',
    ]);
  });

  it('finds a dependency hoisted above the requirer', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { dependencies: { a: '1' } }),
      'node_modules/prisma/node_modules/a': pkg('a', { dependencies: { hoisted: '1' } }),
      'node_modules/hoisted': pkg('hoisted'),
    });
    const result = runScript(root);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.lines).toEqual([
      'node_modules/hoisted',
      'node_modules/prisma',
      'node_modules/prisma/node_modules/a',
    ]);
  });

  it('terminates on a dependency cycle and lists each package once', () => {
    const root = tree({
      'node_modules/prisma': pkg('prisma', { dependencies: { a: '1' } }),
      'node_modules/a': pkg('a', { dependencies: { b: '1' } }),
      'node_modules/b': pkg('b', { dependencies: { a: '1', prisma: '1' } }),
    });
    const result = runScript(root);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.lines).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/prisma']);
  });

  it('on the real install: the CLI and its engines are in, the app and its dev tooling are out', () => {
    const result = runScript(ROOT);
    expect(result.ok, result.stderr).toBe(true);
    for (const wanted of ['node_modules/prisma', 'node_modules/@prisma/engines', 'node_modules/@prisma/config']) {
      expect(result.lines, wanted).toContain(wanted);
    }
    for (const unwanted of ['node_modules/next', 'node_modules/react', 'node_modules/vitest', 'node_modules/@prisma/client']) {
      expect(result.lines, unwanted).not.toContain(unwanted);
    }
    // The tree is closed: every dependency of every listed package resolves inside a listed path.
    const listed = new Set(result.lines);
    const inside = (path: string) => [...listed].some((l) => path === l || path.startsWith(`${l}/`));
    for (const rel of result.lines) {
      const manifest = JSON.parse(readFileSync(join(ROOT, rel, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        let dir = join(ROOT, rel);
        let found = '';
        for (;;) {
          const candidate = join(dir, 'node_modules', name);
          if (existsSync(join(candidate, 'package.json'))) {
            found = candidate.slice(ROOT.length + 1);
            break;
          }
          if (dirname(dir) === dir || dir === ROOT) break;
          dir = dirname(dir);
        }
        expect(found, `${rel} needs ${name}`).not.toBe('');
        expect(inside(found), `${found} is copied`).toBe(true);
      }
    }
  });

  it('on the real install: the copied CLI is the version the lockfile pins', () => {
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };
    const result = runScript(ROOT);
    for (const rel of result.lines) {
      const installed = (JSON.parse(readFileSync(join(ROOT, rel, 'package.json'), 'utf8')) as { version: string }).version;
      expect(installed, rel).toBe(lock.packages[rel]?.version);
    }
    expect(result.lines).toContain('node_modules/prisma');
  });
});

describe('Prisma CLI version', () => {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { version?: string }>;
  };
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('the lockfile resolves the CLI inside the range package.json declares', () => {
    const cli = lock.packages['node_modules/prisma'].version as string;
    expect(semver.valid(cli), 'lock holds a version for prisma').not.toBeNull();
    expect(semver.satisfies(cli, pkg.devDependencies.prisma)).toBe(true);
  });

  it('the CLI the migrate image gets equals the @prisma/client the app runs', () => {
    expect(lock.packages['node_modules/prisma'].version).toBe(
      lock.packages['node_modules/@prisma/client'].version,
    );
  });

  it('no shipped deploy file pins a Prisma version of its own', () => {
    for (const file of [HOSTED_FILE, 'docker-compose.yml', '.relay.yml', 'Dockerfile']) {
      expect(code(read(file)), file).not.toMatch(/prisma@\d/);
    }
  });
});
