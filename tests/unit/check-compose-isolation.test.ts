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

  // [name, mutation, the failure message expected for the app or db service]
  const cases: Array<[string, Mutation, string]> = [
    [
      'a service without a logging block',
      replaceFirst('    mem_limit: 512m\n    logging: *default-logging\n', '    mem_limit: 512m\n'),
      'db has no json-file logging block (driver is unset)',
    ],
    [
      'a logging block with another driver',
      replaceFirst('  driver: json-file\n', '  driver: local\n'),
      'app has no json-file logging block (driver is local)',
    ],
    [
      'a logging block without max-file',
      replaceFirst('    max-file: "3"\n', ''),
      'app logging has no max-size and max-file, so its log is never rotated',
    ],
    [
      'a logging block without max-size',
      replaceFirst('    max-size: "10m"\n', ''),
      'app logging has no max-size and max-file, so its log is never rotated',
    ],
    [
      'an app without mem_limit',
      replaceFirst('    mem_limit: 1536m\n', ''),
      'app has no memory limit (mem_limit)',
    ],
    [
      'a db without mem_limit',
      replaceFirst('    mem_limit: 512m\n', ''),
      'db has no memory limit (mem_limit)',
    ],
    [
      'a disabled app healthcheck',
      replaceFirst('      start_interval: 2s\n', '      start_interval: 2s\n      disable: true\n'),
      'app has no healthcheck',
    ],
    [
      'a probe of another path',
      replaceFirst('127.0.0.1:3000/api/health', '127.0.0.1:3000/'),
      'app healthcheck does not probe /api/health',
    ],
    [
      'a probe that accepts any answer below 600',
      replaceFirst('r.ok ? 0 : 1', 'r.status < 600 ? 0 : 1'),
      'app healthcheck does not fail on a non-2xx answer',
    ],
    [
      'a probe that never fails on the answer',
      replaceFirst('r.ok ? 0 : 1', '0'),
      'app healthcheck does not fail on a non-2xx answer',
    ],
    [
      'a healthcheck without start_period',
      replaceFirst('      start_period: 40s\n', ''),
      'app healthcheck has no start_period, so a cold start counts as failures',
    ],
    [
      'a healthcheck with a zero start_period',
      replaceFirst('      start_period: 40s\n', '      start_period: 0s\n'),
      'app healthcheck has no start_period, so a cold start counts as failures',
    ],
    [
      'a healthcheck without retries',
      replaceFirst('      retries: 5\n', ''),
      'app healthcheck sets no retries',
    ],
    [
      'an app that no longer waits for a healthy db',
      replaceFirst('condition: service_healthy', 'condition: service_started'),
      'app does not wait for db with depends_on condition service_healthy',
    ],
  ];

  for (const file of PROD_FILES) {
    describe(file, () => {
      it.each(cases)('fails on %s', (_name, mutate, message) => {
        const result = runGuard(fixture(file, mutate));
        expect(result.stderr).toContain(`${file}: ${message}`);
        expect(result.status).toBe(1);
      });

      it('accepts an explicit 2xx range test instead of r.ok', () => {
        const result = runGuard(
          fixture(
            file,
            replaceFirst('r.ok ? 0 : 1', 'r.status >= 200 && r.status < 300 ? 0 : 1'),
          ),
        );
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      });

      it('rejects a range test that lacks its upper bound', () => {
        const result = runGuard(
          fixture(file, replaceFirst('r.ok ? 0 : 1', 'r.status >= 200 ? 0 : 1')),
        );
        expect(result.stderr).toContain(`${file}: app healthcheck does not fail on a non-2xx answer`);
        expect(result.status).toBe(1);
      });
    });
  }

  it('fails only the mutated file: a bad hosted file leaves docker-compose.yml unreported', () => {
    const result = runGuard(
      fixture('docker-compose.traefik.yml', replaceFirst('    mem_limit: 1536m\n', '')),
    );
    expect(result.stderr).toContain('docker-compose.traefik.yml: app has no memory limit');
    expect(result.stderr).not.toContain('docker-compose.yml: app has no memory limit');
    expect(result.status).toBe(1);
  });
});
