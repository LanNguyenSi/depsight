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
// extraEnv is exported to the guard on top of the test process's environment.
function runGuard(dir: string, extraEnv: Record<string, string> = {}) {
  // The guard scrubs the environment of its `docker compose config` child, so what this
  // machine exports (DATABASE_URL included) must not change a verdict: it is left in place
  // here, and the scrub tests below export their own values.
  const env = { ...process.env, ...extraEnv };
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

    it('fails on a db on a network named host that is not declared external', () => {
      const result = runGuard(
        fixture(PLAIN, (text) =>
          replaceFirst(
            '      - "127.0.0.1:5432:5432"\n',
            '      - "127.0.0.1:5432:5432"\n    networks:\n      - default\n      - hostnet\n',
          )(
            replaceFirst(
              '\nvolumes:\n',
              '\nnetworks:\n  hostnet:\n    name: host\n\nvolumes:\n',
            )(text),
          ),
        ),
      );
      expectFailure(result, PLAIN, ['db is on the network "hostnet" named host (host networking)']);
      expect(result.stderr).not.toContain('external network');
    });

    it('fails on a db on an ipvlan network, while an explicit bridge driver passes', () => {
      const result = runGuard(
        fixture(PLAIN, (text) =>
          replaceFirst(
            '      - "127.0.0.1:5432:5432"\n',
            '      - "127.0.0.1:5432:5432"\n    networks:\n      - default\n      - lan\n',
          )(
            replaceFirst(
              '\nvolumes:\n',
              '\nnetworks:\n  default:\n    driver: bridge\n  lan:\n    driver: ipvlan\n    driver_opts:\n      parent: eth0\n\nvolumes:\n',
            )(text),
          ),
        ),
      );
      expectFailure(result, PLAIN, [
        'db is on the network "lan" with driver ipvlan, expected the bridge driver',
      ]);
      expect(result.stderr).not.toContain('"default" with driver');
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

    it('fails on a dev db published on every interface or on a non-loopback address', () => {
      const result = runGuard(
        fixture(
          DEV,
          replaceFirst(
            '      - "127.0.0.1:5432:5432"\n',
            '      - "5432:5432"\n      - "0.0.0.0:5433:5432"\n      - "192.0.2.1:5434:5432"\n      - "[::1]:5435:5432"\n',
          ),
        ),
      );
      expectFailure(result, DEV, [
        'db publishes 5432->5432 on 0.0.0.0',
        'db publishes 5433->5432 on 0.0.0.0',
        'db publishes 5434->5432 on 192.0.2.1',
      ]);
      // The loopback spelling ::1 is accepted.
      expect(result.stderr).not.toContain('db publishes 5435->5432');
    });

    it('fails on a dev db with network_mode host, which publishes nothing the port check can see', () => {
      const result = runGuard(
        fixture(
          DEV,
          replaceFirst(
            '    ports:\n      # Loopback only: the dev credentials (dev/dev) must not be reachable from the network.\n      - "127.0.0.1:5432:5432"\n',
            '    network_mode: host\n',
          ),
        ),
      );
      expectFailure(result, DEV, ['db sets network_mode "host"']);
    });

    it('fails on a dev db that shares the app network stack while the app publishes 5432', () => {
      const result = runGuard(
        fixtureMany([
          [
            DEV,
            replaceFirst(
              '    ports:\n      # Loopback only: the dev credentials (dev/dev) must not be reachable from the network.\n      - "127.0.0.1:5432:5432"\n',
              '    network_mode: "service:app"\n',
            ),
          ],
          [
            DEV,
            // The app publishes 5432 and drops its wait on db: compose rejects the cycle
            // that network_mode "service:app" would otherwise make with depends_on.
            (text) =>
              text
                .replace('      - "3000:3000"\n', '      - "3000:3000"\n      - "5432:5432"\n')
                .replace('    depends_on:\n      db:\n        condition: service_healthy\n', ''),
          ],
        ]),
      );
      expectFailure(result, DEV, ['db sets network_mode "service:app"']);
    });

    // The dev db goes through the same exposure rules as the production files' db. A
    // network named host is host networking whether or not it is declared external.
    const DEV_PORTS =
      '    ports:\n      # Loopback only: the dev credentials (dev/dev) must not be reachable from the network.\n      - "127.0.0.1:5432:5432"\n';
    const devNetworks = (block: string): Mutation =>
      replaceFirst('volumes:\n  postgres_data:', `networks:\n${block}\nvolumes:\n  postgres_data:`);

    it('fails on a dev db on an external network named host', () => {
      const result = runGuard(
        fixture(DEV, (text) =>
          devNetworks('  hostnet:\n    external: true\n    name: host\n')(
            replaceFirst(DEV_PORTS, '    networks:\n      - hostnet\n')(text),
          ),
        ),
      );
      expectFailure(result, DEV, [
        'db is on the external network "hostnet"',
        'db is on the network "hostnet" named host (host networking)',
      ]);
      // An external network is rejected as such, not also as an unscoped name.
      expect(result.stderr).not.toContain('project-scoped');
    });

    it('fails on a dev file whose default network is declared external with the name host', () => {
      const result = runGuard(
        fixture(DEV, (text) =>
          devNetworks('  default:\n    external: true\n    name: host\n')(
            replaceFirst(DEV_PORTS, '')(text),
          ),
        ),
      );
      expectFailure(result, DEV, [
        'db is on the external network "default"',
        'db is on the network "default" named host (host networking)',
      ]);
    });

    it('fails on a dev db on a network named host that is not declared external', () => {
      const result = runGuard(
        fixture(DEV, (text) =>
          devNetworks('  hostnet:\n    name: host\n')(
            replaceFirst(DEV_PORTS, '    networks:\n      - hostnet\n')(text),
          ),
        ),
      );
      expectFailure(result, DEV, ['db is on the network "hostnet" named host (host networking)']);
      expect(result.stderr).not.toContain('external network');
    });

    it('fails on a dev db on the edge network, declared without external', () => {
      const result = runGuard(
        fixture(DEV, (text) =>
          devNetworks('  edge:\n    name: traefik-public\n')(
            replaceFirst(
              DEV_PORTS,
              `${DEV_PORTS}    networks:\n      - default\n      - edge\n`,
            )(text),
          ),
        ),
      );
      expectFailure(result, DEV, ['db is on the edge network traefik-public']);
      expect(result.stderr).not.toContain('external network');
    });

    it('fails on a dev db on a macvlan network, which needs no published port', () => {
      const result = runGuard(
        fixture(DEV, (text) =>
          devNetworks('  lan:\n    driver: macvlan\n    driver_opts:\n      parent: eth0\n')(
            replaceFirst(DEV_PORTS, '    networks:\n      - lan\n')(text),
          ),
        ),
      );
      expectFailure(result, DEV, [
        'db is on the network "lan" with driver macvlan, expected the bridge driver',
      ]);
      expect(result.stderr).not.toContain('external network');
    });

    it('fails on a dev file without a db service', () => {
      const result = runGuard(
        fixture(DEV, (text) =>
          text
            .replace(/\n  db:\n[\s\S]*?\n(?=volumes:)/, '\n')
            .replace('    depends_on:\n      db:\n        condition: service_healthy\n', ''),
        ),
      );
      expectFailure(result, DEV, ['needs a db service']);
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

  // Ways around the db rules that stay inside the compose file: network options that remove
  // Docker's direct-routing protection, a network name that joins another stack's network,
  // database services other than the one named db, services in the db's network stack and
  // values that a variable can change. Each rule has its own fixture, and every fixture
  // breaks one rule only (the loopback publish of the shipped files stays where it is).
  describe('the routes around the db isolation', () => {
    const DEV_FILE = 'docker-compose.dev.yml';
    const PLAIN_FILE = 'docker-compose.yml';
    const HOSTED_FILE = 'docker-compose.traefik.yml';
    const DEV_PORTS =
      '    ports:\n      # Loopback only: the dev credentials (dev/dev) must not be reachable from the network.\n      - "127.0.0.1:5432:5432"\n';
    const GATEWAY_V4 = 'com.docker.network.bridge.gateway_mode_ipv4';
    // Appends top-level networks to a file that has none (dev) or to its volumes block.
    const withNetworks = (block: string): Mutation =>
      replaceFirst('\nvolumes:\n', `\nnetworks:\n${block}\nvolumes:\n`);
    // Adds services before the top-level volumes block.
    const withServices = (block: string): Mutation =>
      replaceFirst('\nvolumes:\n', `${block}\nvolumes:\n`);

    describe('network driver_opts', () => {
      it('fails on gateway_mode_ipv4 routed on the dev default network, with the loopback publish', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            withNetworks(`  default:\n    driver_opts:\n      ${GATEWAY_V4}: routed\n`),
          ),
        );
        expectFailure(result, DEV_FILE, [
          `db is on network "default" that sets driver_opts "${GATEWAY_V4}"`,
        ]);
        // Nothing else is wrong with the file: only the option is reported.
        expect(result.stderr).not.toContain('publishes');
        expect(result.stderr).toContain('compose isolation check failed (1)');
      });

      it('fails on gateway_mode_ipv4 nat-unprotected in the plain file, with no published port', () => {
        const result = runGuard(
          fixture(PLAIN_FILE, (text) =>
            withNetworks(
              `  default:\n    driver: bridge\n    driver_opts:\n      ${GATEWAY_V4}: nat-unprotected\n`,
            )(
              text.replace(
                /    ports:\n      # Loopback only: the schema-apply[^\n]*\n[^\n]*\n[^\n]*\n/,
                '',
              ),
            ),
          ),
        );
        expectFailure(result, PLAIN_FILE, [
          `db is on network "default" that sets driver_opts "${GATEWAY_V4}"`,
        ]);
        expect(result.stderr).toContain('compose isolation check failed (1)');
      });

      it('fails on trusted_host_interfaces and gateway_mode_ipv6 on the hosted internal network', () => {
        const result = runGuard(
          fixture(
            HOSTED_FILE,
            replaceFirst(
              '  db-internal:\n    internal: true',
              '  db-internal:\n    internal: true\n    driver_opts:\n      com.docker.network.bridge.trusted_host_interfaces: eth0\n      com.docker.network.bridge.gateway_mode_ipv6: routed',
            ),
          ),
        );
        expectFailure(result, HOSTED_FILE, [
          'db is on network "db-internal" that sets driver_opts "com.docker.network.bridge.trusted_host_interfaces"',
          'db is on network "db-internal" that sets driver_opts "com.docker.network.bridge.gateway_mode_ipv6"',
        ]);
      });

      it("fails on driver_opts in the db's own attachment to a network", () => {
        const result = runGuard(
          fixture(
            HOSTED_FILE,
            replaceFirst(
              '    # Only the private db network: not on traefik-public, no published port.\n    networks:\n      - db-internal\n',
              '    networks:\n      db-internal:\n        driver_opts:\n          com.docker.network.endpoint.example: x\n',
            ),
          ),
        );
        expectFailure(result, HOSTED_FILE, [
          `db is on db's attachment to network "db-internal" that sets driver_opts "com.docker.network.endpoint.example"`,
        ]);
      });
    });

    describe('the network name', () => {
      it('fails on a dev network named after the production stack network', () => {
        const result = runGuard(
          fixture(DEV_FILE, withNetworks('  default:\n    name: depsight_db-internal\n')),
        );
        expectFailure(result, DEV_FILE, [
          'db is on the network "default" named "depsight_db-internal", expected the project-scoped name "depsight-dev_default"',
        ]);
        expect(result.stderr).toContain('compose isolation check failed (1)');
      });

      it('fails on a hosted db network that sets a name other than <project>_<key>', () => {
        const result = runGuard(
          fixture(
            HOSTED_FILE,
            replaceFirst(
              '  db-internal:\n    internal: true',
              '  db-internal:\n    internal: true\n    name: shared-db',
            ),
          ),
        );
        expectFailure(result, HOSTED_FILE, [
          'db is on the network "db-internal" named "shared-db", expected the project-scoped name "depsight_db-internal"',
        ]);
      });
    });

    describe('database services other than db', () => {
      // One dev fixture with a service per image spelling. Every service sets
      // network_mode bridge, which the db rules reject, so a service that is not taken for a
      // database shows as a missing message; the busybox control must stay unreported.
      it('holds every postgres image spelling to the db rules, and leaves other images alone', () => {
        const digest = 'a'.repeat(64);
        const images = [
          'postgres',
          'postgres:16-alpine',
          'docker.io/library/postgres:16',
          `ghcr.io/acme/postgres@sha256:${digest}`,
          'registry.example:5000/team/postgres:16@sha256:' + digest,
          'bitnami/postgresql:16',
        ];
        const services = images
          .map((image, index) => `  pg${index}:\n    image: ${image}\n    network_mode: bridge\n`)
          .join('');
        const control = '  control:\n    image: busybox\n    network_mode: bridge\n';
        const result = runGuard(fixture(DEV_FILE, withServices(`\n${services}${control}`)));
        expectFailure(
          result,
          DEV_FILE,
          images.map((_, index) => `pg${index} sets network_mode "bridge"`),
        );
        expect(result.stderr).not.toContain('control');
      });

      it('holds a service that publishes or exposes container port 5432 to the db rules', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            withServices(
              [
                '',
                '  published:',
                '    image: busybox',
                '    network_mode: bridge',
                '    ports:',
                '      - "127.0.0.1:6000:5432"',
                '  exposed:',
                '    image: busybox',
                '    network_mode: bridge',
                '    expose:',
                '      - "5432"',
                '  exposed-range:',
                '    image: busybox',
                '    network_mode: bridge',
                '    expose:',
                '      - "5400-5500/tcp"',
                '  elsewhere:',
                '    image: busybox',
                '    network_mode: bridge',
                '    expose:',
                '      - "5000-5431"',
                '    ports:',
                '      - "127.0.0.1:7000:5433"',
                '',
              ].join('\n'),
            ),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'published sets network_mode "bridge"',
          'exposed sets network_mode "bridge"',
          'exposed-range sets network_mode "bridge"',
        ]);
        expect(result.stderr).not.toContain('elsewhere');
      });

      it('applies the port, network and driver rules to such a service too', () => {
        const result = runGuard(
          fixture(DEV_FILE, (text) =>
            withNetworks('  lan:\n    driver: macvlan\n')(
              withServices(
                [
                  '',
                  '  pg-extra:',
                  '    image: postgres:16-alpine',
                  '    ports:',
                  '      - "5433:5432"',
                  '    networks:',
                  '      - lan',
                  '',
                ].join('\n'),
              )(text),
            ),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'pg-extra publishes 5433->5432 on 0.0.0.0',
          'pg-extra is on the network "lan" with driver macvlan, expected the bridge driver',
        ]);
        // The db service itself is not blamed for it.
        expect(result.stderr).not.toContain('db publishes');
      });
    });

    describe('services in the network stack of a database service', () => {
      it('holds published ports of a service sharing the db stack to the loopback rule, at any depth', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            withServices(
              [
                '',
                '  side:',
                '    image: busybox',
                '    network_mode: "service:db"',
                '    ports:',
                '      - "8080:8080"',
                '  side-deep:',
                '    image: busybox',
                '    network_mode: "service:side"',
                '    ports:',
                '      - "192.0.2.1:8081:8081"',
                '  side-loopback:',
                '    image: busybox',
                '    network_mode: "service:db"',
                '    ports:',
                '      - "127.0.0.1:8082:8082"',
                '  joined:',
                '    image: busybox',
                '    network_mode: "container:some-database"',
                '    ports:',
                '      - "8083:8083"',
                '  unrelated:',
                '    image: busybox',
                '    ports:',
                '      - "8084:8084"',
                '',
              ].join('\n'),
            ),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'side (in the network stack of service:db) publishes 8080->8080 on 0.0.0.0',
          'side-deep (in the network stack of service:side) publishes 8081->8081 on 192.0.2.1',
          'joined (in the network stack of container:some-database) publishes 8083->8083 on 0.0.0.0',
        ]);
        expect(result.stderr).not.toContain('side-loopback');
        expect(result.stderr).not.toContain('unrelated');
      });
    });

    describe('values a variable can change', () => {
      it('fails on a sharer port address or network_mode target from interpolation', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            withServices(
              [
                '',
                '  side-port:',
                '    image: busybox',
                '    network_mode: "service:db"',
                '    ports:',
                '      - "${SIDE_BIND:-127.0.0.1}:8080:8080"',
                '  side-mode:',
                '    image: busybox',
                '    network_mode: "service:${SIDE_TARGET:-db}"',
                '',
              ].join('\n'),
            ),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'side-port sets ports through variable interpolation',
          'side-mode sets network_mode through variable interpolation',
        ]);
      });

      it("fails on a db's network_mode, networks list or expose list from interpolation", () => {
        const result = runGuard(
          fixture(DEV_FILE, (text) =>
            replaceFirst(
              DEV_PORTS,
              `${DEV_PORTS}    network_mode: "\${DEV_NM:-}"\n    expose:\n      - "\${DEV_EXPOSE:-5432}"\n    networks:\n      - "\${DEV_NET:-default}"\n`,
            )(text),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'db sets network_mode through variable interpolation',
          'db sets expose through variable interpolation',
          'db sets networks through variable interpolation',
        ]);
      });

      it('fails on a db port address that comes from interpolation, though the default is loopback', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            replaceFirst('"127.0.0.1:5432:5432"', '"${DEV_DB_BIND:-127.0.0.1}:5432:5432"'),
          ),
        );
        expectFailure(result, DEV_FILE, ['db sets ports through variable interpolation']);
        // The resolved port is on loopback: only the interpolation rule can fail this file.
        expect(result.stderr).not.toContain('publishes');
        expect(result.stderr).toContain('compose isolation check failed (1)');
      });

      it('fails on the same in the plain file with the $VAR spelling', () => {
        const result = runGuard(
          fixture(PLAIN_FILE, replaceFirst('"127.0.0.1:5432:5432"', '"$DB_BIND:5432:5432"')),
        );
        expectFailure(result, PLAIN_FILE, ['db sets ports through variable interpolation']);
      });

      it('fails on a db network name or option from interpolation, though the default is scoped', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            withNetworks('  default:\n    name: ${DEV_DB_NET:-depsight-dev_default}\n'),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'network "default" sets name through variable interpolation',
        ]);
        expect(result.stderr).toContain('compose isolation check failed (1)');
      });

      it('fails on a network driver or external flag from interpolation', () => {
        const result = runGuard(
          fixture(
            DEV_FILE,
            withNetworks('  default:\n    driver: ${DEV_DRIVER:-bridge}\n    external: ${DEV_EXTERNAL:-false}\n'),
          ),
        );
        expectFailure(result, DEV_FILE, [
          'network "default" sets driver through variable interpolation',
          'network "default" sets external through variable interpolation',
        ]);
      });

      it('fails on an internal flag from interpolation on the hosted db network', () => {
        const result = runGuard(
          fixture(
            HOSTED_FILE,
            replaceFirst(
              '  db-internal:\n    internal: true',
              '  db-internal:\n    internal: ${DB_INTERNAL:-true}',
            ),
          ),
        );
        expectFailure(result, HOSTED_FILE, [
          'network "db-internal" sets internal through variable interpolation',
        ]);
      });
    });

    describe("the caller's environment", () => {
      it('ignores an exported DATABASE_URL that would turn a null app DATABASE_URL into a value', () => {
        const fixtureDir = fixture(PLAIN_FILE, (text) =>
          text.replace(/      - DATABASE_URL=postgresql[^\n]*\n/, '      - DATABASE_URL\n'),
        );
        const result = runGuard(fixtureDir, {
          DATABASE_URL: 'postgresql://depsight:sentinel-pw-0f3a@db:5432/depsight',
        });
        expectFailure(result, PLAIN_FILE, ['app sets no DATABASE_URL']);
      });

      it('ignores an exported variable a compose file interpolates', () => {
        const fixtureDir = fixture(
          PLAIN_FILE,
          replaceFirst('name: depsight\n', 'name: ${DEPSIGHT_GUARD_TEST_PROJECT:-wrong}\n'),
        );
        const result = runGuard(fixtureDir, { DEPSIGHT_GUARD_TEST_PROJECT: 'depsight' });
        expectFailure(result, PLAIN_FILE, ['project name is "wrong", expected "depsight"']);
      });

      it('ignores an exported POSTGRES_PASSWORD and COMPOSE_PROJECT_NAME', () => {
        const result = runGuard(fixture(null), {
          POSTGRES_PASSWORD: 'caller-pw',
          COMPOSE_PROJECT_NAME: 'other',
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      });
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
