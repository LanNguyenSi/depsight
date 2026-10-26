// The production schema step (the `migrate` service of docker-compose.traefik.yml, run by the
// .relay.yml post_update hook, which builds it after the pull) must run the Prisma CLI that
// package-lock.json pins, from an image built with the app, and must fetch nothing when it
// runs. A step that downloads a `prisma@<pin>` of its own drifts from the app's @prisma/client
// 6 and needs outbound network on a database network that has none.
//
// These tests read the shipped files as text (no docker needed); the build and a run against
// a real Postgres are covered by the deploy-path test in advisory-dedupe-db.test.ts and by the
// guard script.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  it('copies the lockfile install from the deps stage and the schema from the checkout', () => {
    const deps = stage('deps').body;
    expect(deps).toMatch(/COPY package\.json package-lock\.json \.\/\n/);
    expect(deps).toMatch(/^RUN npm ci$/m);
    const migrate = stage('migrate').body;
    expect(migrate).toMatch(/^COPY --from=deps \/app\/node_modules \.\/node_modules$/m);
    expect(migrate).toMatch(/^COPY prisma \.\/prisma\/$/m);
    // The CLI is found in node_modules/.bin, not downloaded.
    expect(migrate).toMatch(/^ENV PATH="\/app\/node_modules\/\.bin:\$\{PATH\}"$/m);
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
