#!/usr/bin/env node
// Guard for the shipped compose files: the production database must stay off the
// edge network (and, in the hosted file, only on internal networks), its port must
// not be published on every interface, one variable must carry its password, a routed
// service on several networks must name the edge network for Traefik, and the dev
// and production stacks must not share a project name or a database volume.
//
// Usage: node scripts/check-compose-isolation.mjs [dir]
//   dir  directory holding docker-compose*.yml and .relay.yml (default: the repo root)
//
// It resolves each file with `docker compose config --format json`, so it judges the
// same document Docker would run, interpolation included. Needs the docker CLI with
// the compose plugin and no running daemon. Exit 0 = all checks pass, 1 = a check
// failed, 2 = a file could not be resolved.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');

const PROD_FILES = ['docker-compose.yml', 'docker-compose.traefik.yml'];
const DEV_FILE = 'docker-compose.dev.yml';
const HOSTED_FILE = 'docker-compose.traefik.yml';
const LIVE_PASSWORD = 'depsight';
const PROD_PROJECT = 'depsight';
const DEV_PROJECT = 'depsight-dev';
const PROD_VOLUME = 'depsight_postgres_data';
const EDGE_NETWORK = 'traefik-public';
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Value fed through ${POSTGRES_PASSWORD} to see where it lands.
const SENTINEL = 'sentinel-pw-0f3a';

const failures = [];
const fail = (file, message) => failures.push(`${file}: ${message}`);

// An empty env file for every `docker compose config` call: compose reads the project's
// .env for interpolation and COMPOSE_* settings, and a local one must not change the
// result.
const emptyEnvDir = mkdtempSync(join(tmpdir(), 'compose-isolation-'));
const emptyEnvFile = join(emptyEnvDir, 'empty.env');
writeFileSync(emptyEnvFile, '');
process.on('exit', () => rmSync(emptyEnvDir, { recursive: true, force: true }));

// password: the POSTGRES_PASSWORD to set; null leaves it unset.
function resolveCompose(file, password = SENTINEL) {
  // Drop COMPOSE_* so the caller's shell cannot change the project name or file set.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')),
  );
  delete env.POSTGRES_PASSWORD;
  if (password !== null) env.POSTGRES_PASSWORD = password;
  try {
    const out = execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        emptyEnvFile,
        '-f',
        file,
        '--profile',
        '*',
        'config',
        '--format',
        'json',
      ],
      { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out);
  } catch (err) {
    console.error(
      `${file}: cannot resolve with docker compose config: ${err.stderr || err.message}`,
    );
    process.exit(2);
  }
}

const networkNames = (cfg, service) =>
  Object.keys(service.networks ?? { default: null }).map((key) => cfg.networks?.[key]?.name ?? key);

function checkProd(file) {
  const cfg = resolveCompose(file);
  if (cfg.name !== PROD_PROJECT) {
    fail(file, `project name is "${cfg.name}", expected "${PROD_PROJECT}" (set a top-level name:)`);
  }
  const volume = cfg.volumes?.postgres_data?.name;
  if (volume !== PROD_VOLUME) {
    fail(file, `database volume resolves to "${volume}", expected "${PROD_VOLUME}"`);
  }

  const db = cfg.services?.db;
  const app = cfg.services?.app;
  if (!db || !app) {
    fail(file, 'needs an app and a db service');
    return cfg;
  }

  if (db.network_mode !== undefined) fail(file, `db sets network_mode "${db.network_mode}"`);

  const dbNets = networkNames(cfg, db);
  if (dbNets.includes(EDGE_NETWORK)) fail(file, `db is on the edge network ${EDGE_NETWORK}`);
  const dbKeys = Object.keys(db.networks ?? { default: null });
  for (const key of dbKeys) {
    if (cfg.networks?.[key]?.external) fail(file, `db is on the external network "${key}"`);
    // The hosted file keeps db on networks with no route out.
    if (file === HOSTED_FILE && cfg.networks?.[key]?.internal !== true) {
      fail(file, `db is on the network "${key}", which is not internal: true`);
    }
  }
  if (!dbNets.some((name) => networkNames(cfg, app).includes(name))) {
    fail(file, 'app and db share no network');
  }

  for (const port of db.ports ?? []) {
    if (!LOOPBACK.has(port.host_ip ?? '')) {
      fail(file, `db publishes ${port.published}->${port.target} on ${port.host_ip || '0.0.0.0'}`);
    }
  }

  // A routed service on several networks must tell Traefik which one to use, or it
  // may pick the private db network at random.
  for (const [name, service] of Object.entries(cfg.services)) {
    if (service.labels?.['traefik.enable'] !== 'true') continue;
    const nets = Object.keys(service.networks ?? { default: null });
    if (nets.length < 2) continue;
    const chosen = service.labels['traefik.docker.network'];
    const edge = nets
      .map((key) => cfg.networks?.[key])
      .some((net) => net?.external && net.name === chosen);
    if (!edge) {
      fail(
        file,
        `${name} is routed by Traefik on ${nets.length} networks without a traefik.docker.network label naming the external edge network`,
      );
    }
  }

  // One variable carries the password everywhere.
  if (db.environment?.POSTGRES_PASSWORD !== SENTINEL) {
    fail(file, 'db POSTGRES_PASSWORD does not come from ${POSTGRES_PASSWORD}');
  }
  for (const [name, service] of Object.entries(cfg.services)) {
    const url = service.environment?.DATABASE_URL;
    if (url !== undefined && !url.includes(`:${SENTINEL}@`)) {
      fail(file, `${name} DATABASE_URL does not come from \${POSTGRES_PASSWORD}`);
    }
  }
  return cfg;
}

// The hosted stack keeps working with no POSTGRES_PASSWORD at all: the unset and empty
// cases resolve to the password of the live database (see docs/configuration.md).
for (const unset of [null, '']) {
  const cfg = resolveCompose(HOSTED_FILE, unset);
  const label = unset === null ? 'unset' : 'empty';
  if (cfg.services?.db?.environment?.POSTGRES_PASSWORD !== LIVE_PASSWORD) {
    fail(HOSTED_FILE, `db password with POSTGRES_PASSWORD ${label} is not "${LIVE_PASSWORD}"`);
  }
  for (const [name, service] of Object.entries(cfg.services ?? {})) {
    const url = service.environment?.DATABASE_URL;
    if (url !== undefined && !url.includes(`:${LIVE_PASSWORD}@`)) {
      fail(
        HOSTED_FILE,
        `${name} DATABASE_URL with POSTGRES_PASSWORD ${label} is not the live password`,
      );
    }
  }
}

const prod = PROD_FILES.map((file) => [file, checkProd(file)]);

const dev = resolveCompose(DEV_FILE);
if (dev.name !== DEV_PROJECT) {
  fail(DEV_FILE, `project name is "${dev.name}", expected "${DEV_PROJECT}"`);
}
if (prod.some(([, cfg]) => cfg.name === dev.name)) {
  fail(DEV_FILE, `project name "${dev.name}" equals a production project name`);
}
const prodVolumes = new Set(
  prod.flatMap(([, cfg]) => Object.values(cfg.volumes ?? {}).map((v) => v.name)),
);
for (const volume of Object.values(dev.volumes ?? {})) {
  if (prodVolumes.has(volume.name))
    fail(DEV_FILE, `volume "${volume.name}" is also a production volume`);
}

// The deploy hook must follow the compose file instead of holding its own copy of
// the network and the credentials.
const relay = readFileSync(join(dir, '.relay.yml'), 'utf8');
if (relay.includes(EDGE_NETWORK)) fail('.relay.yml', `mentions the edge network ${EDGE_NETWORK}`);
if (/\/\/[^\s:@/]+:[^\s@]+@/.test(relay))
  fail('.relay.yml', 'holds a database URL with inline credentials');

// -p beats COMPOSE_PROJECT_NAME from .env, so every Makefile use of the dev file pins
// the project there as well.
const makefile = readFileSync(join(dir, 'Makefile'), 'utf8');
makefile.split('\n').forEach((line, index) => {
  if (line.includes(DEV_FILE) && !line.includes(`-p ${DEV_PROJECT} `)) {
    fail('Makefile', `line ${index + 1} uses ${DEV_FILE} without -p ${DEV_PROJECT}`);
  }
});

if (failures.length > 0) {
  console.error(`compose isolation check failed (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('compose isolation check passed');
