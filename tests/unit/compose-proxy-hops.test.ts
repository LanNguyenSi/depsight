// The plain self-host stack (docker-compose.yml) has no proxy in front of the app, so it
// trusts no X-Forwarded-For hop unless the operator says otherwise. These tests resolve the
// shipped file with `docker compose config` and read what the app container would get for
// WEBHOOK_TRUSTED_PROXY_HOPS. They skip when the docker CLI with the compose plugin is
// absent (CI has it). The app's own reading of the value is in client-ip.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
const describeIfCompose = dockerCompose.status === 0 ? describe : describe.skip;
if (dockerCompose.status !== 0) {
  console.warn(
    'compose-proxy-hops tests skipped: the docker CLI with the compose plugin is not available',
  );
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

// The app service's resolved WEBHOOK_TRUSTED_PROXY_HOPS in `file`, with the variable set to
// `value` in the caller's environment (undefined = unset) or, with `dotenv`, in the project's
// .env file (compose reads that file for interpolation, which is where an operator sets it).
function resolvedHops(
  file: string,
  value: string | undefined,
  dotenv = false,
): string | null | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsight-compose-hops-'));
  tmpDirs.push(dir);
  fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('COMPOSE_') && key !== 'WEBHOOK_TRUSTED_PROXY_HOPS',
    ),
  );
  env.POSTGRES_PASSWORD = 'test-password';
  if (value !== undefined && !dotenv) env.WEBHOOK_TRUSTED_PROXY_HOPS = value;
  fs.writeFileSync(
    path.join(dir, '.env'),
    value !== undefined && dotenv ? `WEBHOOK_TRUSTED_PROXY_HOPS=${value}\n` : '',
  );
  const result = spawnSync(
    'docker',
    ['compose', '-f', file, '--profile', '*', 'config', '--format', 'json'],
    {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout).services.app.environment.WEBHOOK_TRUSTED_PROXY_HOPS;
}

describeIfCompose('docker-compose.yml WEBHOOK_TRUSTED_PROXY_HOPS', () => {
  const FILE = 'docker-compose.yml';

  // Which input wins: a value the operator sets (shell or .env) wins over the default 0;
  // unset and empty both fall to the default, so the app never sees the blank that
  // lib/client-ip.ts would turn into one trusted hop.
  it.each([
    ['unset', undefined, '0'],
    ['empty', '', '0'],
    ['0', '0', '0'],
    ['1', '1', '1'],
    ['2', '2', '2'],
  ])('resolves to the default 0 or the operator value: %s', (_label, value, expected) => {
    expect(resolvedHops(FILE, value)).toBe(expected);
  });

  it.each([
    ['unset', undefined, '0'],
    ['empty', '', '0'],
    ['1', '1', '1'],
    ['2', '2', '2'],
  ])('reads the operator value from .env too: %s', (_label, value, expected) => {
    expect(resolvedHops(FILE, value, true)).toBe(expected);
  });

  // The hosted file sits behind one Traefik and sets nothing: the app's own default of one
  // trusted hop applies.
  it('leaves the hosted Traefik file to the app default of one hop', () => {
    expect(resolvedHops('docker-compose.traefik.yml', undefined)).toBeUndefined();
  });
});
