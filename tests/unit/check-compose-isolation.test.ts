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

// A directory with the shipped files, `file` mutated by `mutate`.
function fixture(file: string | null, mutate?: Mutation): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsight-compose-guard-'));
  tmpDirs.push(dir);
  for (const name of COPIED) fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  if (file !== null && mutate) {
    const target = path.join(dir, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = mutate(before);
    // A mutation that changes nothing would make its test pass for the wrong reason.
    expect(after, `mutation left ${file} unchanged`).not.toBe(before);
    fs.writeFileSync(target, after);
  }
  return dir;
}

// The guard in its own process group's child with a hard timeout; stdin closed.
function runGuard(dir: string) {
  const result = spawnSync('node', [GUARD, dir], {
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
  ];

  for (const file of PROD_FILES) {
    describe(file, () => {
      it.each(cases)('fails on %s', (_name, mutate, messages) => {
        const result = runGuard(fixture(file, mutate));
        for (const message of messages) expect(result.stderr).toContain(`${file}: ${message}`);
        expect(result.status).toBe(1);
        // A failure of this file is not reported under the other file's name.
        const other = PROD_FILES.find((name) => name !== file) as string;
        expect(result.stderr).not.toContain(`${other}: `);
      });
    });
  }

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
});
