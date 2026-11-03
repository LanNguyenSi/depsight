#!/usr/bin/env node
// Guard for the shipped compose files: the database of every file (production and dev)
// must stay off the host's network stack, the edge network and external networks, use
// only bridge-driver networks and publish its port on loopback only (in the hosted file
// it also sits only on internal networks), one variable must carry the production
// password, a routed service on several networks must name the edge network for Traefik,
// and the dev and production stacks must not share a project name or a database volume.
// It also holds the operational invariants of the same files: every service rotates its
// logs and has a memory limit, and the app has a healthcheck on /api/health that waits
// for the database to be healthy.
//
// Usage: node scripts/check-compose-isolation.mjs [dir]
//   dir  directory holding docker-compose*.yml and .relay.yml (default: the repo root)
//
// It also fails when a compose.y(a)ml, docker-compose.yaml or an override file sits in the
// repo root, because docker compose without -f (make prod) prefers or merges them.
//
// It resolves each file with `docker compose config --format json`, so it judges the
// same document Docker would run, interpolation included, and a second time with
// `--no-interpolate` to see which exposure fields take a value from a variable (an
// operator's .env can change those). The child runs with a scrubbed environment (PATH,
// HOME and the DOCKER_* settings compose reads, plus POSTGRES_PASSWORD set by the guard),
// so the caller's shell cannot change the verdict. Needs the docker CLI with the compose
// plugin and no running daemon. Exit 0 = all checks pass, 1 = a check failed, 2 = a file
// could not be resolved.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// Docker's own host network: a container attached to it shares the host's interfaces.
const HOST_NETWORK = 'host';
// The driver compose uses when a network sets none: a private bridge on the host.
const BRIDGE_DRIVER = 'bridge';
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Value fed through ${POSTGRES_PASSWORD} to see where it lands.
const SENTINEL = 'sentinel-pw-0f3a';
// Project name passed with -p for the one resolve that shows which network names follow
// the project (-p beats a top-level name:, as COMPOSE_PROJECT_NAME and a second checkout
// of a file do at run time).
const SENTINEL_PROJECT = 'guard-sentinel-project';
// What `docker compose` without -f reads from the working directory, in the order
// it looks (compose.yaml before docker-compose.yml, and an override merged over the
// result). `make prod` runs it that way, so none of them may exist next to the shipped files.
const IMPLICIT_COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
];

// Bridge-network driver_opts the shipped files may set. None: every option of the bridge
// driver either changes who can reach a published port or is not needed here, and
// gateway_mode_ipv4/ipv6 (routed, nat-unprotected) and trusted_host_interfaces remove
// Docker's direct-routing protection for the network.
const ALLOWED_DRIVER_OPTS = new Set();
// The port PostgreSQL listens on in the container.
const POSTGRES_PORT = 5432;
// What the child of `docker compose config` may inherit from the caller: where the docker
// CLI finds the compose plugin and its context. Anything else (DATABASE_URL, a variable the
// files interpolate, COMPOSE_*) could change the document it resolves.
const CHILD_ENV_KEEP = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
];

const failures = [];
const fail = (file, message) => failures.push(`${file}: ${message}`);

// An empty env file for every `docker compose config` call, so the project's .env does
// not feed interpolation or the COMPOSE_* settings; the app's env_file still reads it (a
// malformed one ends the check with exit 2).
const emptyEnvDir = mkdtempSync(join(tmpdir(), 'compose-isolation-'));
const emptyEnvFile = join(emptyEnvDir, 'empty.env');
writeFileSync(emptyEnvFile, '');
process.on('exit', () => rmSync(emptyEnvDir, { recursive: true, force: true }));

// password: the POSTGRES_PASSWORD to set; null leaves it unset.
// interpolate: false keeps `${VAR:-default}` as written (docker compose config
// --no-interpolate), to see which fields an environment could change.
// project: a project name passed with -p (null leaves it to the file's name:).
function resolveCompose(file, password = SENTINEL, { interpolate = true, project = null } = {}) {
  const env = Object.fromEntries(
    CHILD_ENV_KEEP.filter((key) => process.env[key] !== undefined).map((key) => [
      key,
      process.env[key],
    ]),
  );
  if (password !== null) env.POSTGRES_PASSWORD = password;
  try {
    const out = execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        emptyEnvFile,
        ...(project === null ? [] : ['-p', project]),
        '-f',
        file,
        '--profile',
        '*',
        'config',
        ...(interpolate ? [] : ['--no-interpolate']),
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

// The resolved DATABASE_URL of a service, or undefined when it sets none. A list-form
// pass-through (`- DATABASE_URL` with the shell variable unset) resolves to null, which
// sets no value: it counts as "sets no DATABASE_URL" and has no password to check.
const databaseUrl = (service) => {
  const value = service.environment?.DATABASE_URL;
  return typeof value === 'string' ? value : undefined;
};

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

// A resolved memory limit: mem_limit or deploy.resources.limits.memory, bytes as a
// number or a numeric string. Anything else counts as not set.
const memoryLimit = (service) => {
  const raw = service.mem_limit ?? service.deploy?.resources?.limits?.memory;
  const bytes = Number(raw);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
};

// `.ok` (fetch's 2xx flag), or both bounds of an explicit test: status >= 200 and < 300.
const ACCEPTS_ONLY_2XX = /\.ok\b|status\s*>=\s*200\b[^;]*status\s*(<\s*300|<=\s*299)\b/;

// Rotation and limits for every service (migrate included), and the app's healthcheck.
// Without rotation the json-file driver grows one file per container for as long as it
// runs; without a memory limit one service can take the host's memory from the database.
function checkOperations(file, cfg) {
  for (const [name, service] of Object.entries(cfg.services)) {
    const logging = service.logging;
    if (logging?.driver !== 'json-file') {
      fail(
        file,
        `${name} has no json-file logging block (driver is ${logging?.driver ?? 'unset'})`,
      );
    } else if (!logging.options?.['max-size'] || !logging.options?.['max-file']) {
      fail(file, `${name} logging has no max-size and max-file, so its log is never rotated`);
    }
    if (memoryLimit(service) === 0) fail(file, `${name} has no memory limit (mem_limit)`);
  }

  const app = cfg.services.app;
  const check = app.healthcheck;
  const command = Array.isArray(check?.test) ? check.test.join(' ') : String(check?.test ?? '');
  if (!check || check.disable === true || check.test?.[0] === 'NONE') {
    fail(file, 'app has no healthcheck');
  } else {
    if (!command.includes('/api/health')) fail(file, 'app healthcheck does not probe /api/health');
    // The probe must judge the answer: r.ok (any 2xx), or an explicit 2xx range test.
    // Without it a 503 from /api/health would still exit 0 and the container stay healthy.
    if (!ACCEPTS_ONLY_2XX.test(command)) {
      fail(
        file,
        'app healthcheck does not fail on a non-2xx answer (expected r.ok or a 200 to 299 status test)',
      );
    }
    if (!check.start_period || /^0+(\.0+)?[a-z]*$/.test(String(check.start_period))) {
      fail(file, 'app healthcheck has no start_period, so a cold start counts as failures');
    }
    if (!(Number(check.retries) >= 1)) fail(file, 'app healthcheck sets no retries');
    // Behind Traefik the route is down until the first passing probe; start_interval keeps
    // that gap at seconds after a recreate instead of a full interval.
    if (!check.start_interval) fail(file, 'app healthcheck sets no start_interval');
  }
  // Node sizes its heap from the cgroup limit (about half of it) unless told otherwise, so
  // the app's heap must be set explicitly and stay below its memory limit.
  const heap = /--max-old-space-size=(\d+)/.exec(String(app.environment?.NODE_OPTIONS ?? ''));
  if (!heap) {
    fail(file, 'app sets no heap size (NODE_OPTIONS=--max-old-space-size=<MiB>)');
  } else if (Number(heap[1]) * 1024 * 1024 >= memoryLimit(app)) {
    fail(file, `app heap of ${heap[1]} MiB is not below its memory limit`);
  }
  if (app.depends_on?.db?.condition !== 'service_healthy') {
    fail(file, 'app does not wait for db with depends_on condition service_healthy');
  }
  if (!cfg.services.db.healthcheck) fail(file, 'db has no healthcheck');
}

// The compose-level rules against exposing the database beyond its own stack. checkProd
// runs them for both production files and the dev block below runs them for the dev file,
// so a rule added here holds for every shipped file. checkProd's other db rules are not
// here because they do not decide who can reach the database.
//
// "A database service" below is every service named db, whose image is postgres (any
// registry, tag or digest spelling) or that publishes or exposes container port 5432
// (dbServices): the rules hold for each of them, not for the service named db alone.
//
//   rule                                  prod  dev  why
//   no network_mode                       yes   yes  host, container:<id> or service:<name>
//                                                    puts the db on another network stack,
//                                                    where the port rule never sees it
//   not on the edge network               yes   yes  Traefik and every routed stack share
//                                                    traefik-public; compose reuses a network
//                                                    of that name even without external: true
//   not on an external network            yes   yes  an external network (a default network
//     (the default network included)                 declared external too) is shared with
//                                                    other stacks, and compose passes the name
//                                                    of the primary one as the container's
//                                                    network mode, so one named host asks for
//                                                    host networking
//   not on a network named host           yes   yes  compose reuses an existing network by
//                                                    name without external: true as well, so
//                                                    name: host is the same request
//   network named <project>_<key>        yes   yes  compose joins an existing network of the
//     for any project name (a second                 resolved name, so a name that does not
//     resolve with -p must follow it)                follow the project is shared with every
//                                                    other stack that resolves to it:
//                                                    name: depsight_db-internal in another
//                                                    stack's file, or a literal name equal to
//                                                    this file's own <project>_<key>, which
//                                                    ignores -p and COMPOSE_PROJECT_NAME
//                                                    (measured: a second project's db reached
//                                                    the first one's db on 5432)
//   only on bridge-driver networks        yes   yes  macvlan or ipvlan give the container its
//     (driver absent or bridge)                      own address on the host's LAN, overlay
//                                                    and third-party drivers reach other
//                                                    hosts; none of them needs a published
//                                                    port, so the port rule never sees them
//   no driver_opts on its networks,       yes   yes  gateway_mode_ipv4/ipv6 routed or
//     the network's or the service's own             nat-unprotected and trusted_host_interfaces
//     (ALLOWED_DRIVER_OPTS is empty)                 remove Docker's direct-routing drop: a
//                                                    peer that routes to the host reaches the
//                                                    port with the loopback publish (routed)
//                                                    or with no publish at all
//                                                    (nat-unprotected); measured on colima
//   only on internal: true networks       hosted no  requireInternalNetworks, see below
//                                         only
//   ports published on loopback only      yes   yes  any other address hands the database
//                                                    and its credentials to the network
//   same port rule for a service that     yes   yes  defence in depth: Docker refuses port
//     shares a database service's                    publishing together with network_mode
//     network stack                                  container: (and service:), so no such route
//                                                    exists today; the rule keeps it closed
//                                                    if that changes
//   no interpolation in the exposure      yes   yes  a ${VAR:-127.0.0.1} host address, a
//     fields: ports, expose, network_mode,           ${NET:-name} network name and the like
//     networks and the network definition            are judged with the default, and an
//                                                    operator's .env can change them. Found
//                                                    with a second `--no-interpolate`
//                                                    resolve (compose-aware: anchors, extends
//                                                    and merge keys are already applied),
//                                                    not by scanning the file text
//   (checkProd only) app and db share a   yes   no   not an exposure rule: it keeps the app
//     network                                        working; the dev wiring is not checked
//   (checkProd only) password from        yes   no   not an exposure rule; the dev file has
//     ${POSTGRES_PASSWORD}                           fixed dev/dev credentials on purpose
//   (checkOperations) db logging, memory  yes   no   operational limits of the production
//     limit, healthcheck                             files, not about who reaches the db
//   (top level) no compose.y(a)ml,        yes   yes  docker compose without -f (make prod)
//     docker-compose.yaml or override                prefers or merges them, and this check
//     file in the repo root                          reads only the three shipped files
//
// requireInternalNetworks differs per file: the hosted file's db publishes nothing and is
// reached only by app and migrate over db-internal, so all its networks must be internal.
// docker-compose.yml (no migrate service: the schema is applied from the host) and the dev
// file (host-side Prisma and database tests, see CONTRIBUTING.md) publish the db port on
// loopback, so their db stays on the default network, which is not internal.
//
// Not covered (known gaps; docs/configuration.md and CHANGELOG.md carry the same list):
//   - a forwarding sidecar (socat, haproxy, an ssh tunnel) whose image is not postgres and
//     which neither publishes nor exposes 5432 itself
//   - a database image that is not named postgres(ql) and declares no 5432 (for example a
//     build: with FROM postgres)
//   - an image, port or network_mode that a variable turns into a database service or into a
//     stack sharer only in the operator's environment (interpolation is checked only on
//     services already recognised as database services or sharers)
//   - compose files an operator selects with -f or COMPOSE_FILE other than the three shipped
//   - daemon-level settings such as allow-direct-routing or iptables false, which no compose
//     file can show

// The service's image without registry, tag or digest: registry:5000/library/postgres:16@sha256:...
// gives postgres.
const imageName = (image) =>
  String(image ?? '')
    .split('@')[0]
    .split('/')
    .pop()
    .split(':')[0];
const isPostgresImage = (service) => /^postgres(ql)?$/i.test(imageName(service.image));

// "5432", "5432/tcp" or a range "5400-5500" in a service's expose list.
const exposesPostgresPort = (service) =>
  (service.expose ?? []).some((entry) => {
    const match = /^(\d+)(?:-(\d+))?(?:\/\w+)?$/.exec(String(entry).trim());
    if (!match) return false;
    const low = Number(match[1]);
    const high = Number(match[2] ?? match[1]);
    return low <= POSTGRES_PORT && POSTGRES_PORT <= high;
  });
const publishesPostgresPort = (service) =>
  (service.ports ?? []).some((port) => Number(port.target) === POSTGRES_PORT);

// Every service the db rules hold for: the one named db, every postgres image and every
// service that publishes or exposes the container port 5432.
function dbServices(cfg) {
  const found = new Map();
  for (const [name, service] of Object.entries(cfg.services ?? {})) {
    if (
      name === 'db' ||
      isPostgresImage(service) ||
      publishesPostgresPort(service) ||
      exposesPostgresPort(service)
    ) {
      found.set(name, service);
    }
  }
  return found;
}

// Services that run in the network stack of a database service: network_mode
// service:<database service or another sharer> or container:<anything>, which could be a
// database container. Name -> what it shares with.
function stackSharers(cfg, databases) {
  const sharers = new Map();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, service] of Object.entries(cfg.services ?? {})) {
      if (databases.has(name) || sharers.has(name)) continue;
      const mode = String(service.network_mode ?? '');
      const target = /^service:(.+)$/.exec(mode)?.[1];
      if (
        mode.startsWith('container:') ||
        (target && (databases.has(target) || sharers.has(target)))
      ) {
        sharers.set(name, mode);
        grew = true;
      }
    }
  }
  return sharers;
}

// A value (any JSON) that holds a compose variable reference: $VAR or ${VAR...}; $$ is a
// literal dollar sign.
const usesInterpolation = (value) =>
  value !== undefined && /\$[{A-Za-z_]/.test(JSON.stringify(value).replaceAll('$$', ''));

// driver_opts is not here: any option fails the driver_opts rule, interpolated or not.
const NETWORK_FIELDS = ['name', 'driver', 'external', 'internal'];

// cfg: the file as resolved by checkProd or the dev block. It is resolved twice more here:
// raw with --no-interpolate, renamed with -p SENTINEL_PROJECT.
function checkDbExposure(file, cfg, { requireInternalNetworks }) {
  const raw = resolveCompose(file, SENTINEL, { interpolate: false });
  const renamed = resolveCompose(file, SENTINEL, { project: SENTINEL_PROJECT });
  const databases = dbServices(cfg);
  for (const [name, service] of databases) {
    checkDbService(file, cfg, raw, renamed, name, service, { requireInternalNetworks });
  }
  for (const [name, sharedWith] of stackSharers(cfg, databases)) {
    const service = cfg.services[name];
    checkPorts(file, service, `${name} (in the network stack of ${sharedWith}) `);
    checkInterpolation(file, name, raw.services?.[name], ['ports', 'network_mode']);
  }
}

function checkDbService(file, cfg, raw, renamed, name, service, { requireInternalNetworks }) {
  if (service.network_mode !== undefined) {
    fail(file, `${name} sets network_mode "${service.network_mode}"`);
  }
  if (networkNames(cfg, service).includes(EDGE_NETWORK)) {
    fail(file, `${name} is on the edge network ${EDGE_NETWORK}`);
  }
  checkInterpolation(file, name, raw.services?.[name], [
    'ports',
    'expose',
    'network_mode',
    'networks',
  ]);
  for (const key of Object.keys(service.networks ?? { default: null })) {
    const network = cfg.networks?.[key];
    if (network?.external) fail(file, `${name} is on the external network "${key}"`);
    if ((network?.name ?? key) === HOST_NETWORK) {
      fail(file, `${name} is on the network "${key}" named ${HOST_NETWORK} (host networking)`);
    }
    // Compose joins a network of the resolved name that already exists, whoever created
    // it. External networks are rejected above. Any other network must be named
    // `<project>_<key>` for whatever project the stack runs under, so two conditions
    // must both hold: the name is `<this file's project>_<key>`, and resolved with a
    // sentinel -p it is `<sentinel>_<key>`. A literal name: fails one of the two: a name
    // equal to `<this file's project>_<key>` fails the sentinel test (it stays the same
    // under -p or COMPOSE_PROJECT_NAME), a name equal to `<sentinel>_<key>` fails the
    // first, and either one is shared with every other stack that resolves to it.
    const followed = renamed.networks?.[key];
    const own = `${cfg.name}_${key}`;
    const expected = `${SENTINEL_PROJECT}_${key}`;
    if (
      !network?.external &&
      ((network?.name ?? key) !== own || (followed?.name ?? key) !== expected)
    ) {
      fail(
        file,
        `${name} is on the network "${key}" named "${network?.name ?? key}", expected the project-scoped name "<project>_${key}" (a name that does not follow the project name -p or COMPOSE_PROJECT_NAME sets is shared with any other stack that resolves to it)`,
      );
    }
    if (network?.driver && network.driver !== BRIDGE_DRIVER) {
      fail(
        file,
        `${name} is on the network "${key}" with driver ${network.driver}, expected the ${BRIDGE_DRIVER} driver`,
      );
    }
    // The network's own options and the service's per-network ones.
    for (const [owner, opts] of [
      [`network "${key}"`, network?.driver_opts],
      [`${name}'s attachment to network "${key}"`, service.networks?.[key]?.driver_opts],
    ]) {
      for (const option of Object.keys(opts ?? {})) {
        if (!ALLOWED_DRIVER_OPTS.has(option)) {
          fail(file, `${name} is on ${owner} that sets driver_opts "${option}"`);
        }
      }
    }
    checkInterpolation(file, name, raw.networks?.[key], NETWORK_FIELDS, `network "${key}"`);
    if (requireInternalNetworks && network?.internal !== true) {
      fail(file, `${name} is on the network "${key}", which is not internal: true`);
    }
  }
  checkPorts(file, service, `${name} `);
}

// Published ports on loopback only.
function checkPorts(file, service, subject) {
  for (const port of service.ports ?? []) {
    if (!LOOPBACK.has(port.host_ip ?? '')) {
      fail(
        file,
        `${subject}publishes ${port.published}->${port.target} on ${port.host_ip || '0.0.0.0'}`,
      );
    }
  }
}

// An exposure field that takes (part of) its value from a variable is judged with the
// default, and the operator's .env or shell can change it afterwards.
function checkInterpolation(file, name, rawEntry, fields, owner = name) {
  for (const field of fields) {
    if (usesInterpolation(rawEntry?.[field])) {
      fail(
        file,
        `${owner} sets ${field} through variable interpolation (${JSON.stringify(rawEntry[field])}), which an operator's environment can change`,
      );
    }
  }
}

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

  // The hosted file keeps db on networks with no route out.
  checkDbExposure(file, cfg, { requireInternalNetworks: file === HOSTED_FILE });
  if (!networkNames(cfg, db).some((name) => networkNames(cfg, app).includes(name))) {
    fail(file, 'app and db share no network');
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
    else if (databaseUrl(cfg.services[name]) === undefined) {
      fail(file, `${name} sets no DATABASE_URL`);
    }
  }

  checkOperations(file, cfg);

  // One variable carries the password everywhere.
  if (db.environment?.POSTGRES_PASSWORD !== SENTINEL) {
    fail(file, 'db POSTGRES_PASSWORD does not come from ${POSTGRES_PASSWORD}');
  }
  for (const [name, service] of Object.entries(cfg.services)) {
    const url = databaseUrl(service);
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
    const url = databaseUrl(service);
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
// The dev database has fixed credentials (dev/dev), so it is held to the same exposure
// rules as the production files' db (the table above checkDbExposure).
if (!dev.services?.db) fail(DEV_FILE, 'needs a db service');
else {
  checkDbExposure(DEV_FILE, dev, { requireInternalNetworks: false });
}
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

// `make prod` runs docker compose without -f: a compose.yaml (preferred over
// docker-compose.yml) or an override file (merged over it) in the repo root decides what
// runs and is never read by this check. Failing on their presence is the choice over
// checking them: no shipped target needs one. The directory is listed once and compared in
// lower case, so a dangling symlink (existsSync would follow it and say no) and a case
// variant (Docker-Compose.Override.yml, which compose merges on a case-insensitive
// filesystem) are found too; the entry is named as found.
const implicit = new Set(IMPLICIT_COMPOSE_FILES);
for (const entry of readdirSync(dir)) {
  if (implicit.has(entry.toLowerCase())) {
    fail(
      entry,
      'exists in the repo root: docker compose without -f (make prod) prefers or merges it, and this check never reads it',
    );
  }
}

if (failures.length > 0) {
  console.error(`compose isolation check failed (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('compose isolation check passed');
