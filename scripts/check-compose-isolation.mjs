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

// A service counts as routed by Traefik when traefik.enable is true or when it has
// router labels (Traefik follows those without traefik.enable while its exposedByDefault
// option is on, the default). Traefik decodes the value with Go's strconv.ParseBool and
// matches the label keys after the `traefik.` root regardless of case, so these are the
// spellings it reads as true.
const TRAEFIK_TRUE = new Set(['1', 't', 'T', 'true', 'TRUE', 'True']);
const ROUTER_LABEL = /^traefik\.(http|tcp|udp)\./i;
const routedByTraefik = (labels) =>
  Object.entries(labels ?? {}).some(
    ([key, value]) =>
      (key.toLowerCase() === 'traefik.enable' && TRAEFIK_TRUE.has(String(value))) ||
      ROUTER_LABEL.test(key),
  );

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

  // A routed service on several networks must tell Traefik to use the edge network, or
  // it may pick another one (the private db network) at random. The label names a Docker
  // network, so the edge network must be external to keep its name unprefixed.
  for (const [name, service] of Object.entries(cfg.services)) {
    if (!routedByTraefik(service.labels)) continue;
    const nets = Object.keys(service.networks ?? { default: null });
    if (nets.length < 2) continue;
    const chosen = service.labels['traefik.docker.network'];
    if (chosen !== EDGE_NETWORK) {
      fail(
        file,
        `${name} is routed by Traefik on ${nets.length} networks and its traefik.docker.network label is ${chosen === undefined ? 'missing' : `"${chosen}"`}, expected "${EDGE_NETWORK}"`,
      );
    }
    const onEdge = nets.some(
      (key) => cfg.networks?.[key]?.external === true && cfg.networks[key].name === EDGE_NETWORK,
    );
    if (!onEdge) {
      fail(
        file,
        `${name} is routed by Traefik on ${nets.length} networks but is not on the external network ${EDGE_NETWORK}`,
      );
    }
  }

  // The app, and in the hosted file the migrate service, set DATABASE_URL here: without
  // it the app takes one from .env (env_file), which the password check below never sees.
  for (const name of file === HOSTED_FILE ? ['app', 'migrate'] : ['app']) {
    if (!cfg.services[name]) fail(file, `needs a ${name} service`);
    else if (cfg.services[name].environment?.DATABASE_URL === undefined) {
      fail(file, `${name} sets no DATABASE_URL`);
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
