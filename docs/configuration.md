# Configuration

## Environment variables

`.env.example` holds the common variables; copy it to `.env` and fill in values before `make dev`. The table below also lists optional variables that `.env.example` leaves out.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | (none; each compose file sets its own) | PostgreSQL connection string. The compose files set it for the app container, so a value in `.env` applies only to commands run on the host (for example `npm run db:push`) |
| `NEXTAUTH_SECRET` | yes | (none) | NextAuth session signing secret (depsight reads this name; next-auth v5's `AUTH_SECRET` is not supported, and the webhook-secret sealing reads only `NEXTAUTH_SECRET`). Generate with `openssl rand -base64 32`. In production (`NODE_ENV=production`, which both compose files set) a missing, empty or blank value stops the server at startup: the process logs the variable's name (never its value) and exits with status 1, like an invalid `SCAN_INTERVAL_MINUTES`. While neither this nor `WEBHOOK_SECRET_KEY` is set, the settings page disables Generate and Rotate with the reason (the API would answer `503`); Remove stays available |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` | Public base URL of the app (next-auth v5's `AUTH_URL` is not supported by the startup check, which validates `NEXTAUTH_URL` and `NEXTAUTH_SECRET` only). In production a missing, empty or not absolute `http(s)` value (a relative path, a bare host name such as `depsight.example.com`) stops the server at startup with exit status 1. A loopback host (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, `*.localhost`) only logs a warning: the self-hosting `docker-compose.yml` publishes port 3000, so an instance reached on the machine itself is legitimate, but behind a public host name it is the `.env.example` default that was never changed, and OAuth callbacks then go to localhost |
| `GITHUB_CLIENT_ID` | in production | (none) | GitHub OAuth client id. A production build (`make prod`, the Docker image) has no Dev Login, so without this pair nobody can sign in. A development build also offers the Dev Login button |
| `GITHUB_CLIENT_SECRET` | in production | (none) | GitHub OAuth client secret. Pair with `GITHUB_CLIENT_ID`; required for every production deployment for the same reason |
| `SCAN_INTERVAL_MINUTES` | optional | `60` | Minutes between automatic background re-scans (auto-scan cron). A whole number from 1 to 35791 (the largest delay a Node timer holds); unset or blank uses 60. Any other value (0, negative, non-numeric, fractional, larger than 35791) stops the server at startup with an error instead of being clamped: the process logs the error and exits with status 1, so a container restart policy (`restart: unless-stopped` in the shipped compose files) sees the failure instead of a server that stays up and answers 500 |
| `SCAN_RUNNING_WINDOW_MS` | optional | `300000` | Milliseconds a RUNNING CVE scan counts as in progress: a new CVE scan of the same repository inside this window returns the running scan instead of starting another (`POST /api/scan` then answers `status: running`). Only a positive number is honoured; anything else uses the default |
| `WEBHOOK_SECRET_KEY` | optional | (none) | Key material that seals the per-repository PR-scan webhook secrets at rest (AES-256-GCM). Unset or blank falls back to `NEXTAUTH_SECRET`. Set it before the first secret is created and keep it: changing it (or `NEXTAUTH_SECRET`, when this is unset) makes every stored webhook secret unreadable until it is rotated. Generate with `openssl rand -base64 32` |
| `GITHUB_WEBHOOK_DISABLED` | optional | `false` | Set to `true` to switch the PR scan webhook off: `POST /api/webhooks/github` answers 404 without reading the request, whatever key material and secrets exist |
| `WEBHOOK_TRUSTED_PROXY_HOPS` | optional | `1` | Number of trusted reverse proxies in front of the app, used to read the client address from `X-Forwarded-For` for the webhook's pre-verification rate limit (60 requests a minute per address, then 600 for the endpoint, or a separate 300 for addresses in GitHub's published hook ranges). `1` suits the traefik deployment; `0` ignores the header (every caller shares one bucket and the endpoint-wide ceiling; no request is classified as a GitHub hook address and nothing is fetched from `api.github.com`); a value that is not a whole number from 0 to 8 falls back to `1` with a warning |
| `GITHUB_WEBHOOK_SCAN_FORKS` | optional | `false` | Instance default for the PR scan webhook: set to `true` to scan pull requests from forks for every tracked repository that has no setting of its own. By default such deliveries are answered 200 and ignored. A repository's owner can opt out per tracked repository in Settings, or opt in on a private one (an `internal` repository counts as private) |

## GitHub OAuth

`make dev` works out of the box with the **Dev Login** on the login page (no GitHub credentials needed); Dev Login exists only in a development build. For real GitHub login, register an OAuth app at [github.com/settings/developers](https://github.com/settings/developers) and add the two `GITHUB_CLIENT_*` values above. It is required for every production deployment.

When registering the OAuth app, set the Homepage URL to your `NEXTAUTH_URL` and the Authorization callback URL to `<NEXTAUTH_URL>/api/auth/callback/github`. depsight requests the scopes `repo`, `user:email` and `read:org`. `repo` gives read and write access to the signed-in user's private repositories, which depsight uses to read manifests and Dependabot alerts, post PR scan comments and enable Dependabot alerts.

```bash
cp .env.example .env
# add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env
make dev
```

## PR scan webhook (optional)

depsight can scan a pull request automatically and post (or update) its CVE comment, instead of only on the dashboard's PR scan button. It uses the same scan as `POST /api/pr-scan`.

**What the PR scan compares.** The PR scan does not read the pull request's changes. It lists the repository's open Dependabot alerts that were not in the baseline: the newest completed CVE scan of the repository by the user the scan runs for; license and dependency scans hold no advisories and are skipped. Without a CVE scan, or without a tracked repository, there is no baseline and every open alert is listed. It also reports the Dependabot-only alert count and risk score over all open alerts, which can differ from the dashboard's values. The OSV channel is not used. A vulnerable dependency added by the pull request is not reported until GitHub raises a Dependabot alert for it. The PR scan stores nothing, so an alert that is not in the baseline is listed on every pull request scanned until another scan of the repository completes. Read the comment as a repository status note, not as a pre-merge gate.

Every tracked repository has its own webhook secret, minted by the user who tracks it. There is no instance-wide secret and no environment variable that enables the endpoint: a repository without a secret simply cannot be scanned through it. The endpoint is always on when sealing key material exists, unless `GITHUB_WEBHOOK_DISABLED=true` switches it off altogether. Requests are rate limited before the body is read (per client address and for the endpoint as a whole); the address is read from `X-Forwarded-For` according to `WEBHOOK_TRUSTED_PROXY_HOPS` (and decides whether GitHub's hook-range budget applies; the app then needs outbound HTTPS to `api.github.com`, and without it every request shares the one ceiling), see [API reference](api.md#github-pull-request-webhook).

1. In depsight open **Settings**, section **PR scan webhook**, and press **Generate secret** next to the repository (it must be tracked). The secret is shown once; copy it now. depsight keeps only a sealed copy and cannot show it again.
2. In the GitHub **repository** go to Settings, Webhooks, Add webhook:
   - **Payload URL:** `<NEXTAUTH_URL>/api/webhooks/github` (the settings section shows it)
   - **Content type:** `application/json`
   - **Secret:** the secret from step 1
   - **Events:** "Let me select individual events", then only **Pull requests**. GitHub also sends a `ping` event when the webhook is created; depsight answers it 200 once the secret is right.
3. To rotate, press **Rotate** in settings, then paste the new secret into the GitHub webhook; the old secret stops verifying at once. **Remove** clears the secret, and deliveries for that repository then scan nothing. Both are the repository's tracking user only.

Use a repository-level webhook. An organisation-level webhook has one secret for all its repositories, which cannot match the per-repository secrets (and its `ping` names no repository), so its deliveries are rejected.

**Fork pull requests are skipped by default.** A verified delivery whose `pull_request.head.repo.full_name` differs from `repository.full_name` (compared case-insensitively; a deleted fork, where `head.repo` is null, counts as a fork) is answered 200 `ignored`. The check runs after the per-repository signature check, so only a caller holding a valid secret can see this answer (an unverifiable delivery still gets the uniform `401`), and before the replay guard and the rate limiters, so a fork delivery spends no scan budget. The default is to skip because on a public repository anyone can open a fork pull request, and the scan comment publishes Dependabot alert data (open alert count, risk score, new alerts). Fork scanning can be switched on for one tracked private repository only (an `internal` repository counts as private; the opt-in is ignored for a public repository, judged from the visibility each delivery reports, so a repository that became public stops scanning forks at once; an explicit **Ignore** still holds there, and `GITHUB_WEBHOOK_SCAN_FORKS=true` then decides alone): in Settings, under the PR scan webhook, the tracking user picks **Scan** or **Ignore** for that repository, or leaves it on the instance default (`PATCH /api/webhook-secrets/[repoId]`, `null` clears it). The setting belongs to the tracking row of that user. When several users track one GitHub repository, each row decides for itself and a delivery is judged by the row whose secret verified it, so one user's opt-in never enables fork scans for another user's row. A row without a setting follows `GITHUB_WEBHOOK_SCAN_FORKS`; set that to `true` only when fork contributors are trusted on every such repository. The deploy needs nothing else: the setting is one nullable column on `Repo`, which the unchanged `prisma db push` applies without a prompt.

**Trust model.** A delivery is verified against the secret of the tracked repository it names (`repository.owner.login` and `repository.name` in the payload): depsight looks up the users who track that repository and have a secret, checks the `X-Hub-Signature-256` HMAC against each of those secrets in constant time, and acts only for the user whose secret verifies. The scan and the comment use that user's GitHub token. If several users track one repository each has their own secret, and a delivery signed with one user's secret never starts a scan for another. Whoever holds a secret can therefore make depsight scan pull requests of that one repository under its owner's token, and nothing else. Every rejection (unsigned, wrong signature, repository not tracked, no secret set) is the same `401`, so the status and body do not reveal which repositories are tracked (the response time can still differ with the number of users tracking the repository). The endpoint is always on when sealing key material exists, unless `GITHUB_WEBHOOK_DISABLED=true`, and it looks up the repository named by the payload before the signature is verified. On a public repository the comment is public; fork pull requests are skipped unless opted in (below).

**Secrets at rest.** HMAC verification needs the plaintext, so the secret cannot be hashed. It is stored sealed with AES-256-GCM, with a key derived (HKDF-SHA256) from `WEBHOOK_SECRET_KEY`, or from `NEXTAUTH_SECRET` when that is unset, and bound to its repository row so a sealed value copied onto another row does not open. If neither variable is set the endpoint answers `503`; a deployment that sets only `AUTH_SECRET` has neither, so set `NEXTAUTH_SECRET` or `WEBHOOK_SECRET_KEY`. A secret that no longer opens (the key material changed) never verifies; Settings marks it "secret unreadable, rotate it", the log carries one warning per affected row id, and rotating mints a new one. Setting a dedicated `WEBHOOK_SECRET_KEY` before the first secret is created keeps webhook secrets independent of session-secret rotation.

**Upgrading from the instance-wide secret.** Earlier unreleased builds read `GITHUB_WEBHOOK_SECRET`. That variable is gone and is ignored: remove it from `.env` (depsight logs a one-time warning at the first delivery while it is still set), generate a secret per repository as above, and update each GitHub webhook. An existing GitHub webhook keeps signing with its old shared secret, so its deliveries answer `401` until a per-repository secret is minted and entered in the webhook's **Secret** field. The deploy needs nothing else: the change adds two nullable columns to `Repo`, which the unchanged `prisma db push` applies without a prompt.

Only the `opened` and `synchronize` actions of `pull_request` start a scan (`reopened` does not); every other event or action is answered 200 and ignored. The scan runs in the background after a `202` answer. See [API reference](api.md#github-pull-request-webhook) for the status codes, the replay protection and the limits.

## Make targets

`make` with no target lists them all.

```bash
make dev           # Start dev environment (foreground): app + Postgres via docker-compose.dev.yml
make dev-up        # Same as dev, but in background
make dev-down      # Stop dev environment
make dev-logs      # Tail dev logs
make dev-ps        # List dev containers
make dev-clean     # Stop the dev stack + delete its DB volumes (project depsight-dev only)
make prod          # Production build + start (docker-compose.yml, project depsight), see Self-hosting below
make prod-down     # Stop production containers
make backup        # Dump the hosted Postgres into backups/, see Backup and restore
make restore       # FILE=<dump.sql> CONFIRM=yes [NO_PRE_BACKUP=yes]: replace the database with a dump (destructive)
make test          # Run tests inside the dev container
make lint          # Lint + type-check inside the dev container
make format        # Prettier (write) inside the dev container
make format-check  # Prettier (check) inside the dev container
make ci            # format-check, lint, type-check and test in the dev container (not the same set as the GitHub CI)
make build         # Production build inside the dev container
make install       # npm ci and prisma generate locally, no Docker
make hooks         # Set up the Husky pre-commit hook (lint-staged)
make clean         # Remove node_modules, .next, dist, build and coverage
```

## Self-hosting

### Which compose file

Production has one documented path for a self-hosted instance: `docker-compose.yml` with `make prod`, described in the rest of this chapter. `docker-compose.traefik.yml` is the file of the hosted instance (deployed by the `.relay.yml` hook), not a second recommended setup: it carries that instance's hostnames and expects an external `traefik-public` network and a Traefik that already runs. Take it as a template only when you run Traefik too, and adapt it first; do not start it as it is. Do not rename either file: the deploy hook and the live instance refer to them by name.

| | `docker-compose.yml` (self-hosting, `make prod`) | `docker-compose.traefik.yml` (hosted instance) |
|---|---|---|
| Reverse proxy | none: you put one in front | Traefik, routes by label (hostnames of the live instance) |
| App port | published on `3000` (bind it to `127.0.0.1` behind a proxy) | not published, reached through `traefik-public` |
| Database port | `127.0.0.1:5432` (loopback only) | not published, on the internal `db-internal` network |
| Networks | the default network | `traefik-public` (external) and `db-internal` (internal) |
| Schema step | by hand, after every upgrade (step 3 below) | the `migrate` service, run by the deploy hook |
| `POSTGRES_PASSWORD` unset | refuses to start | falls back to `depsight`, the live database's password |
| `WEBHOOK_TRUSTED_PROXY_HOPS` | set it to the number of proxies you run (default `1`) | the default `1` matches the one Traefik |

`make prod` runs `docker compose up --build -d` on `docker-compose.yml`: the app image (which starts `node server.js` and nothing else) and a Postgres 16 container. A first deployment needs these steps:

1. Set `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `POSTGRES_PASSWORD` in `.env`. A production build has no Dev Login, so without the GitHub pair nobody can sign in (see [GitHub OAuth](#github-oauth)). `POSTGRES_PASSWORD` is the database password; generate one with `openssl rand -hex 24` (hex keeps it safe inside the connection URL). `docker-compose.yml` builds the app's `DATABASE_URL` from the same variable, so one value sets both and `make prod` refuses to start while it is unset or empty; a `DATABASE_URL` in `.env` is ignored by the app container. Postgres reads the password only when it first creates the data volume, so for a database that already exists see [Rotating the database password](#rotating-the-database-password).
2. Run `make prod`.
3. Apply the schema once, and again after every upgrade; the image does not do it. For example, from a checkout with `npm ci` on the same host, run `( set -a; . ./.env; set +a; DATABASE_URL="postgresql://depsight:${POSTGRES_PASSWORD}@localhost:5432/depsight" npm run db:push )`, which reads the password from `.env` instead of putting it on the command line (a `.env` that holds a password with `$`, quotes or spaces needs quoting for the shell; `openssl rand -hex 24` has none). That runs the pre-push SQL, then `prisma db push`, the same steps as the `.relay.yml` deploy hook (see [Deploying the Advisory unique key](#deploying-the-advisory-unique-key)). `docker-compose.yml` publishes Postgres on `127.0.0.1:5432` only, so the command works from the host itself and from nowhere else; do not widen the binding.
4. Before exposing the host, put the app behind a reverse proxy and publish port 3000 on `127.0.0.1` only (change `3000:3000` to `127.0.0.1:3000:3000`). A reachable 3000 port also bypasses the proxy that `WEBHOOK_TRUSTED_PROXY_HOPS` relies on (see [API reference](api.md#github-pull-request-webhook)).
5. Check `GET /api/health`.

The compose file pins the project name `depsight`, so the database lives in the volume `depsight_postgres_data` wherever the checkout is. Upgrading an older install whose checkout directory was named differently (volume `<directory>_postgres_data`): set `COMPOSE_PROJECT_NAME=<directory>` in `.env` before the first `make prod`, or the stack starts on a new empty volume (the old one stays untouched).

`docker-compose.traefik.yml` is the hosted instance's setup (see [Which compose file](#which-compose-file)): its hostnames and the external `traefik-public` network belong to that instance. The `db` service sits only on a private network (`db-internal`, which compose scopes to the project as `depsight_db-internal`, marked `internal`), never on `traefik-public`, and publishes no port. Because `app` is on both networks, it carries the label `traefik.docker.network=traefik-public`; without it Traefik may pick the private network at random (when its provider default is a different network) and route to an address it cannot reach, so keep the label on any routed service that joins a second network. The deploy hook applies the schema with `docker compose -f docker-compose.traefik.yml run --rm -T --build migrate`, a one-shot service (profile `tools`) that reads the same `POSTGRES_PASSWORD` and joins only `db-internal`. It is the `migrate` stage of this repository's `Dockerfile`: the Prisma CLI is the version `package-lock.json` pins (the one the app's `@prisma/client` matches), and openssl and the schema are baked into the image when it is built. The image holds only the CLI, its engines and the packages the CLI needs to run (the `migrate-cli` stage copies that dependency closure out of the lockfile install, so the version cannot differ from the lockfile), not the app's dependencies: it is about 475 MB on disk (`docker images`; 115 MB by `docker image inspect` on a containerd image store; measured on arm64), where the previous image that copied the whole install was 1.57 GB, so a schema-change deploy, which rebuilds the install layers, leaves a much smaller superseded image behind. Running it downloads nothing, which is why it needs no network with a route out. The `post_update` hook builds it itself (`run --build`, from the cache when nothing changed, so a schema change always lands): the relay runs `pre_update` on the tree from before the pull, a plain `docker compose build` skips a profile-scoped service, and `run` alone reuses an existing image, so an image built any earlier would carry the previous commit's schema. The build is the only step that can fetch packages (on a cache miss), and it runs before the container starts. Building the image needs BuildKit (the Docker buildx plugin, Engine 23 or later), because the `migrate-cli` stage uses a `RUN` heredoc: the classic builder (`DOCKER_BUILDKIT=0`, or Compose without buildx) skips the heredoc body and the build fails at the next `COPY`. In this file an unset or empty `POSTGRES_PASSWORD` falls back to `depsight`, the password the hosted database was created with, so an existing deployment keeps working without any change to `.env`; set the variable (and rotate, below) to move off it. A fresh install should set it before the first start.

### Dev and production stacks never share a checkout

`docker-compose.dev.yml` is the development stack (project `depsight-dev`, its own database volume `depsight-dev_postgres_data`); `docker-compose.yml` and `docker-compose.traefik.yml` are production (project `depsight`, volume `depsight_postgres_data`). The `make dev*`, `make test` and `make dev-clean` targets pin `-p depsight-dev`, so they cannot start, replace or delete the production stack or its volume. Still, run the dev stack on a development machine and the production stack on the server, never both from one checkout: a `COMPOSE_PROJECT_NAME` in `.env` overrides the `name:` in the files (only the `-p` flag in the Makefile beats it), so a bare `docker compose -f docker-compose.dev.yml ...` in a production checkout that sets it would use the production project. The dev database from earlier checkouts lives in `depsight_postgres_data`; the dev stack now starts with an empty `depsight-dev_postgres_data`, and the old volume is yours to keep or remove by hand (on a production host it is the production data: leave it).

`node scripts/check-compose-isolation.mjs` (run by CI) fails when a production file puts `db` on `traefik-public` or publishes it on all interfaces, when `db` sets a `network_mode` or (in the hosted file) sits on a network that is not `internal: true`, when a service that Traefik routes (`traefik.enable` true in any spelling Traefik accepts, or any `traefik.http.`, `traefik.tcp.` or `traefik.udp.` label) sits on several networks without the label `traefik.docker.network=traefik-public` or without being on the external `traefik-public` network, when the app (or, in the hosted file, the `migrate` service) sets no `DATABASE_URL`, when a database password stops coming from `POSTGRES_PASSWORD`, when the project names or volumes of the stacks collide, or when a `Makefile` dev target loses its `-p` pin. It also fails when a production service has no `json-file` logging block with `max-size` and `max-file` or no memory limit, when the app has no healthcheck on `/api/health` that fails on a non-2xx answer (`r.ok` or an explicit 200 to 299 test) with a `start_period` and a `start_interval`, when the app sets no explicit heap size (`NODE_OPTIONS=--max-old-space-size=<MiB>`) below its memory limit, or when the app stops waiting for `db` with `condition: service_healthy` (see [Health check, resource limits and log rotation](#health-check-resource-limits-and-log-rotation)). It resolves the files with `docker compose config` and an empty `--env-file`, so a local `.env` does not feed the interpolation or the `COMPOSE_*` settings. Compose still reads `.env` as the app's `env_file`, though: its variables reach the resolved app environment where the file sets none, and a malformed `.env` makes the check exit 2 (cannot resolve).

### Health check, resource limits and log rotation

Both production files give the `app` service a healthcheck, and every service (`app`, `db` and, in the hosted file, `migrate`) a memory limit and a rotated log.

**Healthcheck.** The `app` container runs an inline `node -e` probe every 30 seconds that requests `http://127.0.0.1:3000/api/health` and exits 1 on any non-2xx answer, so the 503 that `/api/health` returns when the database is unreachable counts as a failed probe. The fetch gives up after 9 seconds, inside the probe `timeout` of 10 seconds, so a slow answer fails the probe instead of hanging it. Five failed probes in a row (`retries: 5`, about 2.5 minutes) mark the container `unhealthy`. The runner image has neither `curl` nor `wget`, hence Node. `start_period: 40s` is the grace for a cold Next start: failed probes inside it do not count, and the first success ends it. `start_interval: 2s` probes every 2 seconds during that period, so the container turns `healthy` about 2 seconds after the server answers (`start_interval` needs Docker Engine 25 or later; on an older engine the first probe runs after one `interval`, 30 seconds). `depends_on: db: condition: service_healthy` already held for the app in both files and is kept.

**Plain compose does not restart an unhealthy container.** `restart: unless-stopped` reacts to a process exit only. `unhealthy` is a status that `docker ps` and `docker compose ps` show; a hung server stays up until someone restarts it (`docker compose restart app`). The shipped files add no restarter on purpose.

**Behind Traefik the status also decides routing.** Traefik's docker provider does not route to a container whose health is `starting` or `unhealthy` (the default; it keeps them only when `allowEmptyServices` is set). With `docker-compose.traefik.yml` this has two effects: (a) right after a recreate or restart of `app`, the public routes (`depsight` and `ci-insights`) answer 404 until the first passing probe, about the `start_interval` of 2 seconds after the server is up; (b) after five failed probes in a row, because the database is down or because the event loop was blocked past the probe timeout, the routes answer 404 until a probe passes again, instead of the app's own error page. The container itself keeps running in both cases.

**What the deploy gate sees.** The relay deploy check in `.relay.yml` requests `/api/health` from inside every running service, five times five seconds apart, and rolls back when none answers. It is a database check and stays one: the missing-secret case is stopped earlier, because the server exits at startup (see `NEXTAUTH_SECRET` and `NEXTAUTH_URL` above) and never answers the check. Measured with the hosted file and no `NEXTAUTH_SECRET`: the app container restarted in a loop, and all five attempts failed. The check runs inside the container and ignores the Docker health status, so it can pass while Traefik still answers 404 for the first seconds after a recreate.

**Memory limits** (`mem_limit`): `app` 1536 MB, `db` 512 MB, `migrate` 512 MB. They bound what one service can take from a host that also builds images and runs other stacks, so an out-of-memory kill hits the service that grew instead of whichever process has the largest resident set. The numbers rest on a dummy environment and on one idle instance, not on a measured scan peak:

- `app`: the V8 heap is the binding limit, and it is explicit. `NODE_OPTIONS=--max-old-space-size=1024` on the `app` service sets the old-space ceiling to 1024 MiB; without it Node derives the ceiling from the container's memory cap (about half of 1 GB, 524 MiB, measured with `v8.getHeapStatistics()`), which would cut the heap to a size nobody chose. The 1536 MB cap leaves 512 MB for buffers and native memory around that heap. An idle production instance used about 420 MiB. The Next build is not under this limit: it runs at image build time (`docker compose build`), before the container exists.
- `db`: idle 39 MiB; Postgres 16 with its default `shared_buffers` of 128 MB and a handful of connections fits 512 MB with room for the page cache.
- `migrate`: one-shot `prisma db execute` plus `prisma db push` from the image. The 102 MiB peak (sampled every 2 seconds) was measured on the earlier step that installed openssl and downloaded `prisma` with `npx` at run time; the image-based step has not been sampled. 512 MB is kept.

A single `docker stats --no-stream` snapshot says little, because memory peaks while a scan runs. Before the first deploy with these limits, and again after a change to the scan load, sample `docker stats` across a full auto-scan cycle (`SCAN_INTERVAL_MINUTES`, 60 by default) and watch `docker logs` for `Reached heap limit` and `docker ps` for restarts. A service that reaches its cap, or an `app` that dies with a heap error, needs a higher `mem_limit` (and, for `app`, a higher `--max-old-space-size` that stays below it).

**Log rotation.** Each service logs through `json-file` with `max-size: 10m` and `max-file: 3`, at most about 30 MB per service. Without it the driver keeps one unbounded file per container. A limit applies to a container when it is created, so the first deploy recreates `app` and `db` (see below).

**One-time effect of the first deploy.** Changing `mem_limit`, `logging` or `healthcheck` changes the container configuration, so `docker compose up` recreates the containers instead of leaving them running. Expect the `db` service to restart once (a few seconds; its data stays in the volume `depsight_postgres_data`) and the app to be recreated with it. Behind Traefik the app's routes answer 404 for a few seconds until the first healthy probe (see above). No manual step is needed beyond the `docker stats` sampling above, and the production `.env` must hold a non-empty `NEXTAUTH_SECRET` and an absolute `NEXTAUTH_URL`: without them the new app container exits at startup, the deploy check fails and the relay rolls back.

### Rotating the database password

Postgres reads `POSTGRES_PASSWORD` only when it creates an empty data directory, so changing the variable alone makes the app fail to log in. Rotate in this order, on the host, in the checkout (the commands below are for the hosted `docker-compose.traefik.yml`; for the self-hosting `docker-compose.yml` drop the `-f docker-compose.traefik.yml` part and finish with step 3 of [Self-hosting](#self-hosting) instead of the last `migrate` line, which only the hosted file defines):

```bash
(
  set -e
  NEW=$(openssl rand -hex 24)
  # 1. change it inside the running database (the password goes in over stdin, not the
  #    command line); ON_ERROR_STOP=1 makes psql exit non-zero when the ALTER fails
  printf "ALTER USER depsight WITH PASSWORD '%s';\n" "$NEW" \
    | docker compose -f docker-compose.traefik.yml exec -T db psql -v ON_ERROR_STOP=1 -U depsight -d depsight
  # 2. record it where compose reads it: drop any old POSTGRES_PASSWORD line, then append.
  #    umask 077 keeps the temporary copy (and a .env this creates) readable by you only;
  #    grep exits 1 when it keeps no line (fine) and 2 on an error (stops here); cat >
  #    keeps the mode of an existing .env; the leading newline keeps a .env without a
  #    trailing newline intact. POSIX tools only, the same on BSD and GNU.
  umask 077
  touch .env
  rm -f .env.tmp
  grep -v '^POSTGRES_PASSWORD=' .env > .env.tmp || [ $? -eq 1 ]
  cat .env.tmp > .env
  rm .env.tmp
  printf '\nPOSTGRES_PASSWORD=%s\n' "$NEW" >> .env
  # 3. recreate the app (and db) with the new value, then check the schema step and health
  docker compose -f docker-compose.traefik.yml up -d
  docker compose -f docker-compose.traefik.yml run --rm -T --build migrate
)
```

The block is one `set -e` subshell rather than an `&&` chain: every step stays a plain line, the first command that fails ends the block, and `set -e`, the `umask` and `NEW` stay inside the subshell, so they cannot change your shell or close it on an error. A failed `ALTER` therefore stops the block before `.env` is touched: `ON_ERROR_STOP=1` makes psql exit non-zero, and psql is the last command of its pipeline, whose status `set -e` sees. Paste it into `bash` or `sh` (in zsh run `setopt interactive_comments` first, or zsh runs the comment lines as commands and the block stops at the first one, before the `ALTER`). Paste it as it is: `set -e` does not apply to a command on the left of `||` or `&&`, which is why the `grep` line ends in `|| [ $? -eq 1 ]` (a plain `|| true` would also hide a read error and then empty `.env`), and a `|| ...` after the closing parenthesis would switch it off for the whole block. If it stops in step 2, the database already has the new password while `.env` still holds the old one: run the `ALTER USER` again with the value from `.env` (and delete a leftover `.env.tmp`); if `.env` has lost its `POSTGRES_PASSWORD` line (a failure after the `cat` line, for example a full disk), write a new value into `.env` and run the `ALTER USER` with that value. If it stops in step 3, both hold the new password and step 3 can run again.

Between steps 1 and 3 new connections from the old app container fail, so do it in a quiet moment. To go back, run the `ALTER USER` again with the old value and restore the `.env` line. There is no other place to edit: the app, the `db` service, the `migrate` service and the deploy hook all read `POSTGRES_PASSWORD`. The hosted database still has the original password `depsight` until someone rotates it this way.

### Backup and restore

The database in the volume `depsight_postgres_data` is the only state depsight keeps that cannot be rebuilt (repositories, scan history, tokens, policies, webhook secrets). A deploy never backs it up and nothing in the compose files does it for you: **scheduling `scripts/backup.sh` on the host is the operator's job**, and a lost volume without a dump is a lost instance. The commands below are for the hosted `docker-compose.traefik.yml`, run in the checkout.

**Backup.** `scripts/backup.sh` (or `make backup`) runs `pg_dump --clean --if-exists` inside the `db` service through `docker compose exec -T`, so the host needs no Postgres client and the database stays on its private network. It writes plain SQL (readable, restorable with `psql` alone, validated on the host with `grep`), to a hidden temp file first, checks that the file is at least 1 KiB and carries pg_dump's "dump complete" marker, and only then renames it to `backups/depsight-<YYYYMMDD_HHMMSS>.sql` (directory mode 700, files 600; a second run in the same second gets a `-<pid>` suffix instead of overwriting). The marker must be a line of its own, so the text inside a data row does not count. A failed run never leaves a truncated `.sql` behind. It refuses to start (exit 2) while the `db` service is not running in the compose file, so a cron job cannot report success for a stack that is down. Exit codes: 0 done, 1 dump failed or invalid, 2 refused (configuration, compose file, db not running), 3 dump kept but the off-host hook failed.

```bash
# crontab of the user that runs docker, daily at 03:17 (install it yourself; nothing does it for you)
17 3 * * * cd /path/to/depsight && scripts/backup.sh >> "$HOME/depsight-backup.log" 2>&1
```

Keep the log under the home directory of that user: a user in the `docker` group cannot create files in `/var/log`, and a cron redirect that cannot open its file means the script never runs, with no error anywhere you would look.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_COMPOSE_FILE` | `docker-compose.traefik.yml` in the checkout | Compose file of the stack to back up |
| `BACKUP_DB_SERVICE` | `db` | Compose service that runs Postgres |
| `BACKUP_DIR` | `backups/` in the checkout (git-ignored and in `.dockerignore`) | Where dumps go. Inside the checkout only `backups/` is accepted (see below) |
| `BACKUP_SKIP_ROTATION` | (unset) | Any value skips the rotation (`restore.sh` sets it for its pre-restore dump) |
| `PG_USER`, `PG_DB` | `depsight`, `depsight` | Database role and name |
| `KEEP_FILES` | `14` | Keep at most this many dumps |
| `KEEP_DAYS` | `14` | Delete dumps older than this many days |
| `BACKUP_OFFHOST_HOOK` | (unset) | Executable that copies a finished dump off the host |

**Where dumps may live.** The dumps hold every user's GitHub OAuth token in clear text. The `Dockerfile` copies the whole checkout (`COPY . .`) and the deploy hook builds from it on every deploy, so a dump anywhere in the checkout would be sent to the Docker daemon and kept in the BuildKit cache, unless `.dockerignore` excludes it. It excludes `backups`, and only that path: `backup.sh` refuses (exit 2) a `BACKUP_DIR` that lies inside the checkout but not in `backups/`, and a custom `BACKUP_DIR` must not be inside the build context at all (put it outside the checkout, for example `/var/backups/depsight` created for the cron user, or on another disk). The default stays `backups/` next to the compose file so that the cron line and `make backup` need no configuration.

**Retention.** After a successful run the script keeps the newest `KEEP_FILES` dumps and deletes any older than `KEEP_DAYS` days; the dump it just wrote is never aged out. A run that fails (including a failed off-host hook) rotates nothing, so a broken run never pushes the last good dump out. A dump is about the size of the data (about 30 KiB for the empty schema plus a handful of rows): plan `KEEP_FILES` x dump size of disk.

**Off-host copy.** Dumps in `backups/` live on the same disk as the database, so a lost host loses the restore points too. Set `BACKUP_OFFHOST_HOOK` to the path of an executable; it is called once per successful dump with the dump path as its only argument, for example a script that runs `gpg --encrypt` and `rclone copy`. The dump holds every user's GitHub OAuth token in clear text and the sealed webhook secrets, so encrypt it in the hook before it leaves the host. A hook that is not an executable file stops the run before dumping (exit 2); a hook that fails makes the run exit 3 with the local dump kept. The dump does not contain `.env`: back that up separately (`NEXTAUTH_SECRET` and `WEBHOOK_SECRET_KEY` are the key material of the sealed webhook secrets, and a restore without them leaves those secrets unreadable).

**Restore.** `scripts/restore.sh --yes <dump.sql>` (or `make restore FILE=<dump.sql> CONFIRM=yes`) replaces the content of the running database with the dump. It is destructive: the whole `public` schema is dropped and recreated before the dump is loaded, so every table that is not in the dump is gone and rows written after the dump are lost. (Loading the dump over the existing tables is not enough: `pg_dump --clean` only drops what it knows, and a table a newer release added with a foreign key into a dumped table makes the restore fail.) Without `--yes` it only says so, naming the compose file it would act on, and exits 2; without a file argument it never runs. There is no interactive prompt. In order it:

1. checks the file (size and completion marker as a whole line) and that `db` is running;
2. **stops the `app` service** (its open connections would block the `DROP`s and it would write rows meanwhile; `RESTORE_APP_SERVICE` names another service, an empty value leaves the app alone);
3. takes a dump of the **current** state with `scripts/backup.sh` into `BACKUP_DIR` (rotation skipped, so it can never age out the file you are restoring), unless you pass `--no-pre-backup` (`NO_PRE_BACKUP=yes` for `make restore`). If that backup fails nothing has been changed: the app is started again and the script exits 3. A nearly empty database is below the size floor of the validation and fails the same way; restore into it with `--no-pre-backup`;
4. feeds `DROP SCHEMA public CASCADE`, the re-creation of the schema with the owner and grants of a fresh PostgreSQL 16 database, and the dump to `psql -v ON_ERROR_STOP=1 --single-transaction` (any error rolls the whole restore back and the database keeps its old content; the app stays stopped);
5. runs the `migrate` service (`docker compose -f <file> run --rm -T --build migrate`, the step every deploy runs from `.relay.yml`; `RESTORE_MIGRATE_SERVICE` names another service, an empty value skips it), so a dump that predates a schema change gets the tables and columns the deployed code expects before any request arrives;
6. starts the app again, only after steps 4 and 5 succeeded.

Why `restore.sh` runs the migrate step itself instead of leaving it to you: the app must not start against an older schema, and a restore is the moment someone is least likely to remember a second command. The cost is a build of the migrate image (as on every deploy). If you skip it, run it yourself before `docker compose -f docker-compose.traefik.yml start app`. Exit codes: 0 restored, 1 invalid dump, app could not be stopped (nothing changed) or psql failed (rolled back), 2 refused, 3 the pre-restore backup failed (nothing changed), 4 the dump is restored but the migrate step or the app start failed (the message prints the command to run).

```bash
ls -t backups/depsight-*.sql | head -3                      # pick a dump
scripts/restore.sh --yes backups/depsight-20261027_031700.sql   # backup of now, stop app, restore, migrate, start app
curl -fsS https://depsight.opentriologue.ai/api/health          # the app answers again
```

The dump is the schema and the data of the moment it was taken. Restoring a dump taken from newer code than the deployed code is not supported: the migrate step may refuse to drop what the older schema lacks (exit 4, app left stopped). The dump does not carry roles: it assumes the `depsight` role of the same compose file exists, as it does on a stack created from it.

**Restore drill.** A backup that has never been restored is a hope. CI job `Restore drill (Postgres)` runs `scripts/restore-drill.sh` on every push and pull request: it applies the schema like the `migrate` service (the pre-push SQL, then `prisma db push`), seeds users and repositories, runs the real `scripts/backup.sh`, restores that dump with the real `scripts/restore.sh` into a freshly created second database, and asserts the row counts, the content of one row, a stored token and the Advisory unique index. It then repeats the restore into that populated database after adding a table with a foreign key into a dumped table (what a newer release does) and a row written after the dump, and asserts that both are gone, that the pre-restore dump holds them, that the schema owner is the one of a fresh database and that `prisma db push` finds the restored schema in sync; last, a dump that fails half way must leave the database unchanged. The scripts see a `docker` shim that forwards their `docker compose exec -T db ...` calls to a scratch Postgres container, so every `pg_dump` and `psql` option the drill uses is the one in the scripts; if the options drift or the dump stops restoring, the job fails. The shim has no `app` or `migrate` service, so stopping the app, the migrate step and the start are covered by the stub tests (`scripts/restore.test.sh`) only. Run it by hand against a scratch container (never production) with `DRILL_PG_CONTAINER=<container> DRILL_DATABASE_URL=postgresql://depsight:<password>@127.0.0.1:<port>/depsight scripts/restore-drill.sh`. The drill proves the scripts work; it does not prove that your cron job runs, that the off-host copy arrives, or that you hold the `.env` key material. Do a real restore into a spare stack now and then, and check the age of the newest dump in `backups/`.

### Network access

The app needs outbound HTTPS to these hosts:

- GitHub REST API (`api.github.com`): repository and CI sync, Dependabot alerts, manifests, PR comments, and the hook ranges of the PR scan webhook (`api.github.com/meta`).
- OSV (`api.osv.dev`): the second CVE channel.
- Package registries for dependency age: `registry.npmjs.org`, `pypi.org`, `proxy.golang.org`, `crates.io`, `repo.packagist.org`, `search.maven.org`.
- Package registries for license detection: `registry.npmjs.org`, `pypi.org`, `repo.packagist.org`, `crates.io`, `repo1.maven.org`.
- Each user-configured outgoing webhook and Slack URL.

An unreachable source does not fail the scan: an unreadable GitHub or OSV source marks the scan degraded (see [Known limitations](features.md#known-limitations)), and a failed registry lookup leaves that package as an unknown or needs-review row.

## Database management

These run inside the Docker container automatically on `make dev`. For manual use:

```bash
npm run db:generate    # Generate Prisma client
npm run db:pre-push    # Dedupe Advisory rows and create their unique index (idempotent, see below)
npm run db:push        # db:pre-push, then prisma db push
npm run db:studio      # Database GUI
```

### Deploying the Advisory unique key

`Advisory` carries a unique key over `(scanId, ghsaId, packageName)`. A database
that already holds duplicate rows (a monorepo scan stored the same advisory and
package once per manifest) cannot take that key: `prisma db push` fails with
`P2002`, and Prisma also refuses any push that adds a unique key without
`--accept-data-loss`, duplicates or not. The schema is applied with `db push`
and there is no migrations directory, so the step that makes the push possible
is part of the deploy itself and needs no operator action and no flag:

- The production deploy (`.relay.yml` `post_update`, the `migrate` service of
  `docker-compose.traefik.yml`) runs
  `prisma db execute --file prisma/pre-push/advisory-unique-key.sql` and then the
  unchanged `prisma db push --skip-generate`, with the Prisma CLI that
  `package-lock.json` pins (built into the image, not fetched when the step runs). If
  the SQL fails the deploy stops before the push.
- `npm run db:push` (development, or a manual push) runs the same SQL first via
  `npm run db:pre-push`.

The SQL removes the duplicates and then creates the unique index itself, under
the name and columns Prisma generates for the schema line
(`Advisory_scanId_ghsaId_packageName_key`), so the push that follows finds that
index present and has nothing to warn about. It keeps the most complete row of
each `(scanId, ghsaId, packageName)` group (a fixed version first, then an
affected range, then a published date, ties by smallest id), recomputes the CVE
counts and risk score of every scan that lost rows, does nothing on a fresh
database (the push creates the table and the key) and is safe to repeat. The
push of this release also drops the old single-column `scanId` index, which the
unique key makes redundant; dropping an index carries no data-loss warning. Do
not run a bare `prisma db push` against a database that may still hold
duplicates. The development container (`docker/entrypoint.dev.sh`) calls
`npm run db:push` too.

The key stays in place when a deploy is rolled back to an earlier release (the
relay rolls back after `post_update`, so the SQL has already committed).
Releases before the key do not collapse repeated Dependabot alerts, so their CVE
scans of repositories with repeated alerts fail with `P2002` until the next
forward deploy. For an intentional downgrade, run
`DROP INDEX "Advisory_scanId_ghsaId_packageName_key";` first.

## CI Health (GitHub Actions sync)

The **CI Health** tab in the dashboard surfaces GitHub Actions analytics (fail rates, build times, flaky jobs). depsight ingests the data itself: it reads workflow runs and jobs from the GitHub API with the repository owner's stored GitHub token (`lib/ci/ingest.ts`) and stores them in its own database. No separate service is involved and nothing extra needs to be deployed.

> The tab is only visible for a repository once CI data has been synced for it. A repository with no GitHub Actions workflows never gets the tab.

### Setup

Nothing to configure beyond the GitHub sign-in that connects your repositories. The sync runs:

- on every cycle of the auto-scan cron (`SCAN_INTERVAL_MINUTES`), for all of a user's tracked repositories;
- after each repository scanned by the dashboard's scan-all action;
- on demand from the CI Health tab, or through the API.

Each sync covers runs created in the last 30 days, at most 100 per workflow, and skips runs it already stored. To trigger one through the API, use a `WRITE`-scoped API token (a `READ` token gets 403) or a signed-in session; omit `repoId` to sync all tracked repositories. The endpoint is rate limited per user, see [Rate limits](api.md#rate-limits):

```bash
curl -X POST https://<your-depsight>/api/ci/sync \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"repoId": "<repo-id>"}'
```
