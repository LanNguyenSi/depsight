// Runs scripts/check-compose-isolation.mjs against fixture directories: copies of the
// shipped compose files, .relay.yml and Makefile, with one text mutation each. CI only runs
// the guard on the shipped files, so without these a disabled check goes unnoticed.
//
// The guard resolves the files with `docker compose config`, so the tests need the docker
// CLI with the compose plugin (no daemon). They skip when it is absent; CI has it.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GUARD = path.join(ROOT, 'scripts/check-compose-isolation.mjs');
const COPIED = [
  'docker-compose.yml',
  'docker-compose.traefik.yml',
  'docker-compose.dev.yml',
  '.relay.yml',
  'Makefile',
];
const PROD_FILES = ['docker-compose.yml', 'docker-compose.traefik.yml'] as const;

const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
const hasCompose = dockerCompose.status === 0;
const describeIfCompose = hasCompose ? describe : describe.skip;
if (!hasCompose) {
  console.warn('check-compose-isolation tests skipped: the docker CLI with the compose plugin is not available');
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

type Mutation = (text: string) => string;

// A directory with the shipped files, each `[file, mutate]` pair applied to its file.
function fixtureMany(mutations: Array<[string, Mutation]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsight-compose-guard-'));
  tmpDirs.push(dir);
  for (const name of COPIED) fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  for (const [file, mutate] of mutations) {
    const target = path.join(dir, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = mutate(before);
    // A mutation that changes nothing would make its test pass for the wrong reason.
    expect(after, `mutation left ${file} unchanged`).not.toBe(before);
    fs.writeFileSync(target, after);
  }
  return dir;
}

// A directory with the shipped files, `file` mutated by `mutate`.
function fixture(file: string | null, mutate?: Mutation): string {
  return fixtureMany(file !== null && mutate ? [[file, mutate]] : []);
}

// The guard as a child with a hard timeout and stdin closed. It runs at a low priority
// (nice): its many docker CLI launches would otherwise starve the timing-sensitive
// process-spawning tests that run in parallel with this file.
function runGuard(dir: string) {
  // A list-form `- DATABASE_URL` passes the caller's value through; the null cases need it
  // unset, whatever the machine running the tests exports.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync('nice', ['-n', '15', 'node', GUARD, dir], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Replace the first occurrence of `from`; a mutation whose anchor vanished throws.
const replaceFirst =
  (from: string, to: string): Mutation =>
  (text) => {
    if (!text.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
    return text.replace(from, to);
  };

describeIfCompose('check-compose-isolation guard', () => {
  it('passes on the shipped compose files', () => {
    const result = runGuard(fixture(null));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('compose isolation check passed');
  });

  // Each guard run resolves five compose files through `docker compose config`, so mutations
  // on different lines of the same file share one run (the guard reports every failure),
  // while mutations of one line or one shared anchor get a run of their own.
  // [name, mutation, every failure message expected from the app or db service]
  const cases: Array<[string, Mutation, string[]]> = [
    [
      'several independent breakages at once',
      (text) =>
        [
          replaceFirst('    mem_limit: 512m\n    logging: *default-logging\n', '    mem_limit: 512m\n'),
          replaceFirst('    mem_limit: 1536m\n', ''),
          replaceFirst('127.0.0.1:3000/api/health', '127.0.0.1:3000/'),
          replaceFirst('r.ok ? 0 : 1', 'r.status < 600 ? 0 : 1'),
          replaceFirst('      start_period: 40s\n', ''),
          replaceFirst('      retries: 5\n', ''),
          replaceFirst('condition: service_healthy', 'condition: service_started'),
        ].reduce((acc, mutate) => mutate(acc), text),
      [
        'db has no json-file logging block (driver is unset)',
        'app has no memory limit (mem_limit)',
        'app healthcheck does not probe /api/health',
        'app healthcheck does not fail on a non-2xx answer',
        'app healthcheck has no start_period, so a cold start counts as failures',
        'app healthcheck sets no retries',
        'app does not wait for db with depends_on condition service_healthy',
      ],
    ],
    [
      'a logging block with another driver',
      replaceFirst('  driver: json-file\n', '  driver: local\n'),
      ['app has no json-file logging block (driver is local)'],
    ],
    [
      'a logging block without max-file',
      replaceFirst('    max-file: "3"\n', ''),
      ['app logging has no max-size and max-file, so its log is never rotated'],
    ],
    [
      'a logging block without max-size',
      replaceFirst('    max-size: "10m"\n', ''),
      ['app logging has no max-size and max-file, so its log is never rotated'],
    ],
    [
      'a db without mem_limit',
      replaceFirst('    mem_limit: 512m\n', ''),
      ['db has no memory limit (mem_limit)'],
    ],
    [
      'a disabled app healthcheck',
      replaceFirst('      start_interval: 2s\n', '      start_interval: 2s\n      disable: true\n'),
      ['app has no healthcheck'],
    ],
    [
      'a healthcheck with a zero start_period',
      replaceFirst('      start_period: 40s\n', '      start_period: 0s\n'),
      ['app healthcheck has no start_period, so a cold start counts as failures'],
    ],
    [
      'a healthcheck without start_interval',
      replaceFirst('      start_interval: 2s\n', ''),
      ['app healthcheck sets no start_interval'],
    ],
    [
      'an app without an explicit heap size',
      replaceFirst('      - NODE_OPTIONS=--max-old-space-size=1024\n', ''),
      ['app sets no heap size (NODE_OPTIONS=--max-old-space-size=<MiB>)'],
    ],
    [
      'an app heap at its memory limit',
      replaceFirst('--max-old-space-size=1024', '--max-old-space-size=1536'),
      ['app heap of 1536 MiB is not below its memory limit'],
    ],
  ];

  // The combined case runs on both production files, the single-line cases on the hosted
  // one: both files carry the same lines, and every guard run costs five docker CLI calls.
  const [combined, ...single] = cases;
  for (const file of PROD_FILES) {
    it(`fails on ${combined[0]} in ${file}`, () => {
      const result = runGuard(fixture(file, combined[1]));
      for (const message of combined[2]) expect(result.stderr).toContain(`${file}: ${message}`);
      expect(result.status).toBe(1);
      // A failure of this file is not reported under the other file's name.
      const other = PROD_FILES.find((name) => name !== file) as string;
      expect(result.stderr).not.toContain(`${other}: `);
    });
  }

  it.each(single)('fails on %s in the hosted file', (_name, mutate, messages) => {
    const result = runGuard(fixture('docker-compose.traefik.yml', mutate));
    for (const message of messages) {
      expect(result.stderr).toContain(`docker-compose.traefik.yml: ${message}`);
    }
    expect(result.status).toBe(1);
  });

  // The probe must fail on the answer's status. The mutations all rewrite one line of the
  // hosted file, the same line in the other file is identical.
  describe('the healthcheck verdict', () => {
    const file = 'docker-compose.traefik.yml';

    it.each([
      'r.status >= 200 && r.status < 300 ? 0 : 1',
      'r.status >= 200 && r.status <= 299 ? 0 : 1',
    ])('accepts the explicit 2xx test %s instead of r.ok', (test) => {
      const result = runGuard(fixture(file, replaceFirst('r.ok ? 0 : 1', test)));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it.each([
      'r.status >= 200 ? 0 : 1',
      'r.status >= 200 && r.status < 600 ? 0 : 1',
      'r.status >= 200 && r.status <= 300 ? 0 : 1',
      '0',
    ])('rejects the test %s that does not stop at 299', (test) => {
      const result = runGuard(fixture(file, replaceFirst('r.ok ? 0 : 1', test)));
      expect(result.stderr).toContain(`${file}: app healthcheck does not fail on a non-2xx answer`);
      expect(result.status).toBe(1);
    });
  });

  // The isolation predicates. Each run resolves five compose files, so independent
  // breakages of one file share a run; every message is asserted with its file prefix.
  const HOSTED = 'docker-compose.traefik.yml';
  const PLAIN = 'docker-compose.yml';
  const expectFailure = (result: ReturnType<typeof runGuard>, file: string, messages: string[]) => {
    for (const message of messages) expect(result.stderr).toContain(`${file}: ${message}`);
    expect(result.stderr).not.toContain('TypeError');
    expect(result.status).toBe(1);
  };

  describe('the database isolation', () => {
    it('fails on a db on the edge network, off the internal network, and with unsafe ports', () => {
      const result = runGuard(
        fixture(HOSTED, (text) =>
          replaceFirst(
            '    # Only the private db network: not on traefik-public, no published port.\n    networks:\n      - db-internal\n',
            '    ports:\n      - "5432:5432"\n    networks:\n      - db-internal\n      - traefik-public\n',
          )(
            replaceFirst(
              '  db-internal:\n    internal: true',
              '  db-internal:\n    driver: bridge',
            )(text),
          ),
        ),
      );
      expectFailure(result, HOSTED, [
        'db is on the edge network traefik-public',
        'db is on the external network "traefik-public"',
        'db is on the network "traefik-public", which is not internal: true',
        'db is on the network "db-internal", which is not internal: true',
        'db publishes 5432->5432 on 0.0.0.0',
      ]);
    });

    it('fails on a db port without a loopback host IP, a network_mode and literal passwords', () => {
      const result = runGuard(
        fixture(PLAIN, (text) =>
          [
            replaceFirst(
              '      - "127.0.0.1:5432:5432"\n',
              '      - "5432:5432"\n      - "192.0.2.1:5433:5432"\n      - "[::1]:5434:5432"\n',
            ),
            replaceFirst(
              '    image: postgres:16-alpine\n',
              '    image: postgres:16-alpine\n    network_mode: bridge\n',
            ),
            replaceFirst(
              'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env (an existing database keeps its current password, depsight if you never changed it)}\n',
              'POSTGRES_PASSWORD: hunter2\n',
            ),
            replaceFirst(
              'postgresql://depsight:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env (an existing database keeps its current password, depsight if you never changed it)}@db',
              'postgresql://depsight:hunter2@db',
            ),
          ].reduce((acc, mutate) => mutate(acc), text),
        ),
      );
      expectFailure(result, PLAIN, [
        'db publishes 5432->5432 on 0.0.0.0',
        'db publishes 5433->5432 on 192.0.2.1',
        'db sets network_mode "bridge"',
        'db POSTGRES_PASSWORD does not come from ${POSTGRES_PASSWORD}',
        'app DATABASE_URL does not come from ${POSTGRES_PASSWORD}',
      ]);
      // The loopback spelling ::1 is accepted.
      expect(result.stderr).not.toContain('db publishes 5434->5432');
    });

    it('fails on a hosted file whose fallback is not the live password', () => {
      const result = runGuard(
        fixture(HOSTED, (text) =>
          replaceFirst(
            'DATABASE_URL: postgresql://depsight:${POSTGRES_PASSWORD:-depsight}@db',
            'DATABASE_URL: postgresql://depsight:${POSTGRES_PASSWORD:-other}@db',
          )(
            replaceFirst(
              'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-depsight}',
              'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-other}',
            )(text),
          ),
        ),
      );
      expectFailure(result, HOSTED, [
        'db password with POSTGRES_PASSWORD unset is not "depsight"',
        'db password with POSTGRES_PASSWORD empty is not "depsight"',
        'migrate DATABASE_URL with POSTGRES_PASSWORD unset is not the live password',
        'migrate DATABASE_URL with POSTGRES_PASSWORD empty is not the live password',
      ]);
    });
  });

  describe('the Traefik routing', () => {
    it('fails on a routed multi-network service with no network label and off the edge network', () => {
      const result = runGuard(
        fixture(HOSTED, (text) =>
          replaceFirst(
            '      - "traefik.docker.network=traefik-public"\n',
            '',
          )(
            replaceFirst(
              '      - traefik-public\n      - db-internal\n',
              '      - default\n      - db-internal\n',
            )(text),
          ),
        ),
      );
      expectFailure(result, HOSTED, [
        'app is routed by Traefik on 2 networks and its traefik.docker.network label is missing, expected "traefik-public"',
        'app is routed by Traefik on 2 networks but is not on the external network traefik-public',
      ]);
    });

    it('fails on a network label that names another network, while the app stays on the edge network', () => {
      const result = runGuard(
        fixture(
          HOSTED,
          replaceFirst(
            'traefik.docker.network=traefik-public',
            'traefik.docker.network=db-internal',
          ),
        ),
      );
      expectFailure(result, HOSTED, [
        'app is routed by Traefik on 2 networks and its traefik.docker.network label is "db-internal", expected "traefik-public"',
      ]);
      expect(result.stderr).not.toContain('but is not on the external network');
    });
  });

  describe('the dev stack', () => {
    const DEV = 'docker-compose.dev.yml';

    it('fails on a dev project name equal to a production name', () => {
      const result = runGuard(
        fixture(DEV, replaceFirst('name: depsight-dev\n', 'name: depsight\n')),
      );
      expectFailure(result, DEV, [
        'project name is "depsight", expected "depsight-dev"',
        'project name "depsight" equals a production project name',
      ]);
    });

    it('fails on a dev volume that is also a production volume, with the project name intact', () => {
      const result = runGuard(
        fixture(
          DEV,
          replaceFirst(
            '  postgres_data:\n  next_cache:',
            '  postgres_data:\n    name: depsight_postgres_data\n  next_cache:',
          ),
        ),
      );
      expectFailure(result, DEV, ['volume "depsight_postgres_data" is also a production volume']);
      expect(result.stderr).not.toContain('project name');
    });

    it('fails on a .relay.yml that names the edge network or holds credentials, and on an unpinned Makefile use', () => {
      const result = runGuard(
        fixtureMany([
          [
            '.relay.yml',
            replaceFirst(
              'rollback: true',
              'rollback: true\nnetwork: traefik-public\nenv: postgresql://depsight:hunter2@db:5432/depsight',
            ),
          ],
          [
            'Makefile',
            replaceFirst(
              'DC_DEV = docker compose -p depsight-dev -f',
              'DC_DEV = docker compose -f',
            ),
          ],
        ]),
      );
      expectFailure(result, '.relay.yml', [
        'mentions the edge network traefik-public',
        'holds a database URL with inline credentials',
      ]);
      expectFailure(result, 'Makefile', [
        'line 9 uses docker-compose.dev.yml without -p depsight-dev',
      ]);
    });
  });

  // A list-form `- DATABASE_URL` (or a map-form `DATABASE_URL:`) whose shell variable is
  // unset resolves to null. That is "sets no DATABASE_URL", not a crash and not a URL.
  describe('a null DATABASE_URL', () => {
    it('is reported as unset for the app in docker-compose.yml', () => {
      const result = runGuard(
        fixture(PLAIN, (text) =>
          text.replace(/      - DATABASE_URL=postgresql[^\n]*\n/, '      - DATABASE_URL\n'),
        ),
      );
      expectFailure(result, PLAIN, ['app sets no DATABASE_URL']);
      // No other message about a password: the null service is skipped by the password check.
      expect(result.stderr).not.toContain('DATABASE_URL does not come from');
    });

    it('is reported as unset for the app and migrate in the hosted file', () => {
      const result = runGuard(
        fixture(HOSTED, (text) =>
          replaceFirst(
            '      DATABASE_URL: postgresql://depsight:${POSTGRES_PASSWORD:-depsight}@db:5432/depsight\n',
            '      DATABASE_URL:\n',
          )(text.replace(/      - DATABASE_URL=postgresql[^\n]*\n/, '      - DATABASE_URL\n')),
        ),
      );
      expectFailure(result, HOSTED, ['app sets no DATABASE_URL', 'migrate sets no DATABASE_URL']);
      expect(result.stderr).not.toContain('with POSTGRES_PASSWORD');
      expect(result.stderr).not.toContain('DATABASE_URL does not come from');
    });
  });
});
