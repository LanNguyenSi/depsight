# Configuration

## Environment variables

`.env.example` holds the common variables; copy it to `.env` and fill in values before `make dev`. The table below also lists optional variables that `.env.example` leaves out.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | (none; each compose file sets its own) | PostgreSQL connection string. The compose files set it for the app container, so a value in `.env` applies only to commands run on the host (for example `npm run db:push`) |
| `NEXTAUTH_SECRET` | yes | (none) | NextAuth session signing secret. Generate with `openssl rand -base64 32`. While neither this nor `WEBHOOK_SECRET_KEY` is set, the settings page disables Generate and Rotate with the reason (the API would answer `503`); Remove stays available |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` | Public base URL of the app |
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

`make prod` runs `docker compose up --build -d` on `docker-compose.yml`: the app image (which starts `node server.js` and nothing else) and a Postgres 16 container. A first deployment needs these steps:

1. Set `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `POSTGRES_PASSWORD` in `.env`. A production build has no Dev Login, so without the GitHub pair nobody can sign in (see [GitHub OAuth](#github-oauth)). `POSTGRES_PASSWORD` is the database password; generate one with `openssl rand -hex 24` (hex keeps it safe inside the connection URL). `docker-compose.yml` builds the app's `DATABASE_URL` from the same variable, so one value sets both and `make prod` refuses to start while it is unset or empty; a `DATABASE_URL` in `.env` is ignored by the app container. Postgres reads the password only when it first creates the data volume, so for a database that already exists see [Rotating the database password](#rotating-the-database-password).
2. Run `make prod`.
3. Apply the schema once, and again after every upgrade; the image does not do it. For example, from a checkout with `npm ci` on the same host, run `( set -a; . ./.env; set +a; DATABASE_URL="postgresql://depsight:${POSTGRES_PASSWORD}@localhost:5432/depsight" npm run db:push )`, which reads the password from `.env` instead of putting it on the command line (a `.env` that holds a password with `$`, quotes or spaces needs quoting for the shell; `openssl rand -hex 24` has none). That runs the pre-push SQL, then `prisma db push`, the same steps as the `.relay.yml` deploy hook (see [Deploying the Advisory unique key](#deploying-the-advisory-unique-key)). `docker-compose.yml` publishes Postgres on `127.0.0.1:5432` only, so the command works from the host itself and from nowhere else; do not widen the binding.
4. Before exposing the host, put the app behind a reverse proxy and publish port 3000 on `127.0.0.1` only (change `3000:3000` to `127.0.0.1:3000:3000`). A reachable 3000 port also bypasses the proxy that `WEBHOOK_TRUSTED_PROXY_HOPS` relies on (see [API reference](api.md#github-pull-request-webhook)).
5. Check `GET /api/health`.

The compose file pins the project name `depsight`, so the database lives in the volume `depsight_postgres_data` wherever the checkout is. Upgrading an older install whose checkout directory was named differently (volume `<directory>_postgres_data`): set `COMPOSE_PROJECT_NAME=<directory>` in `.env` before the first `make prod`, or the stack starts on a new empty volume (the old one stays untouched).

`docker-compose.traefik.yml` is the hosted setup and an example for a traefik deployment: its hostnames and the external `traefik-public` network must be adapted before use. The `db` service sits only on a private network (`db-internal`, which compose scopes to the project as `depsight_db-internal`, marked `internal`), never on `traefik-public`, and publishes no port. Because `app` is on both networks, it carries the label `traefik.docker.network=traefik-public`; without it Traefik may pick the private network at random (when its provider default is a different network) and route to an address it cannot reach, so keep the label on any routed service that joins a second network. The deploy hook applies the schema with `docker compose -f docker-compose.traefik.yml run --rm -T migrate`, a one-shot service (profile `tools`) that joins that network and reads the same `POSTGRES_PASSWORD`. In this file an unset or empty `POSTGRES_PASSWORD` falls back to `depsight`, the password the hosted database was created with, so an existing deployment keeps working without any change to `.env`; set the variable (and rotate, below) to move off it. A fresh install should set it before the first start.

### Dev and production stacks never share a checkout

`docker-compose.dev.yml` is the development stack (project `depsight-dev`, its own database volume `depsight-dev_postgres_data`); `docker-compose.yml` and `docker-compose.traefik.yml` are production (project `depsight`, volume `depsight_postgres_data`). The `make dev*`, `make test` and `make dev-clean` targets pin `-p depsight-dev`, so they cannot start, replace or delete the production stack or its volume. Still, run the dev stack on a development machine and the production stack on the server, never both from one checkout: a `COMPOSE_PROJECT_NAME` in `.env` overrides the `name:` in the files (only the `-p` flag in the Makefile beats it), so a bare `docker compose -f docker-compose.dev.yml ...` in a production checkout that sets it would use the production project. The dev database from earlier checkouts lives in `depsight_postgres_data`; the dev stack now starts with an empty `depsight-dev_postgres_data`, and the old volume is yours to keep or remove by hand (on a production host it is the production data: leave it).

`node scripts/check-compose-isolation.mjs` (run by CI) fails when a production file puts `db` on `traefik-public` or publishes it on all interfaces, when `db` sets a `network_mode` or (in the hosted file) sits on a network that is not `internal: true`, when a service that Traefik routes (`traefik.enable` true in any spelling Traefik accepts, or any `traefik.http.`, `traefik.tcp.` or `traefik.udp.` label) sits on several networks without the label `traefik.docker.network=traefik-public` or without being on the external `traefik-public` network, when the app (or, in the hosted file, the `migrate` service) sets no `DATABASE_URL`, when a database password stops coming from `POSTGRES_PASSWORD`, when the project names or volumes of the stacks collide, or when a `Makefile` dev target loses its `-p` pin. It resolves the files with `docker compose config` and an empty `--env-file`, so a local `.env` does not feed the interpolation or the `COMPOSE_*` settings. Compose still reads `.env` as the app's `env_file`, though: its variables reach the resolved app environment where the file sets none, and a malformed `.env` makes the check exit 2 (cannot resolve).

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
  grep -v '^POSTGRES_PASSWORD=' .env > .env.tmp || [ $? -eq 1 ]
  cat .env.tmp > .env
  rm .env.tmp
  printf '\nPOSTGRES_PASSWORD=%s\n' "$NEW" >> .env
  # 3. recreate the app (and db) with the new value, then check the schema step and health
  docker compose -f docker-compose.traefik.yml up -d
  docker compose -f docker-compose.traefik.yml run --rm -T migrate
)
```

The block is one `set -e` subshell rather than an `&&` chain: every step stays a plain line, the first command that fails ends the block, and `set -e`, the `umask` and `NEW` stay inside the subshell, so they cannot change your shell or close it on an error. A failed `ALTER` therefore stops the block before `.env` is touched: `ON_ERROR_STOP=1` makes psql exit non-zero, and psql is the last command of its pipeline, whose status `set -e` sees. Paste it as it is: `set -e` does not apply to a command on the left of `||` or `&&`, which is why the `grep` line ends in `|| [ $? -eq 1 ]` (a plain `|| true` would also hide a read error and then empty `.env`), and a `|| ...` after the closing parenthesis would switch it off for the whole block.

Between steps 1 and 3 new connections from the old app container fail, so do it in a quiet moment. To go back, run the `ALTER USER` again with the old value and restore the `.env` line. There is no other place to edit: the app, the `db` service, the `migrate` service and the deploy hook all read `POSTGRES_PASSWORD`. The hosted database still has the original password `depsight` until someone rotates it this way.

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
  unchanged `prisma db push --skip-generate`. If the SQL fails the deploy stops
  before the push.
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
