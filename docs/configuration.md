# Configuration

## Environment variables

`.env.example` ships the full set; copy it to `.env` and fill in values before `make dev`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgresql://depsight:password@localhost:5432/depsight` | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | yes | (none) | NextAuth session signing secret. Generate with `openssl rand -base64 32`. While neither this nor `WEBHOOK_SECRET_KEY` is set, the settings page disables Generate and Rotate with the reason (the API would answer `503`); Remove stays available |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` | Public base URL of the app |
| `GITHUB_CLIENT_ID` | optional | (none) | GitHub OAuth client id. Only needed for real GitHub login (the **Dev Login** button works without it) |
| `GITHUB_CLIENT_SECRET` | optional | (none) | GitHub OAuth client secret. Pair with `GITHUB_CLIENT_ID` |
| `SCAN_INTERVAL_MINUTES` | optional | `60` | Minutes between automatic background re-scans (auto-scan cron). A whole number from 1 to 35791 (the largest delay a Node timer holds); unset or blank uses 60. Any other value (0, negative, non-numeric, fractional, larger than 35791) stops the server at startup with an error instead of being clamped: the process logs the error and exits with status 1, so a container restart policy (`restart: unless-stopped` in the shipped compose files) sees the failure instead of a server that stays up and answers 500 |
| `WEBHOOK_SECRET_KEY` | optional | (none) | Key material that seals the per-repository PR-scan webhook secrets at rest (AES-256-GCM). Unset or blank falls back to `NEXTAUTH_SECRET`. Set it before the first secret is created and keep it: changing it (or `NEXTAUTH_SECRET`, when this is unset) makes every stored webhook secret unreadable until it is rotated. Generate with `openssl rand -base64 32` |
| `GITHUB_WEBHOOK_DISABLED` | optional | `false` | Set to `true` to switch the PR scan webhook off: `POST /api/webhooks/github` answers 404 without reading the request, whatever key material and secrets exist |
| `WEBHOOK_TRUSTED_PROXY_HOPS` | optional | `1` | Number of trusted reverse proxies in front of the app, used to read the client address from `X-Forwarded-For` for the webhook's pre-verification rate limit (60 requests a minute per address, then 600 for the endpoint, or a separate 300 for addresses in GitHub's published hook ranges). `1` suits the traefik deployment; `0` ignores the header (every caller shares one bucket); a value that is not a whole number from 0 to 8 falls back to `1` with a warning |
| `GITHUB_WEBHOOK_SCAN_FORKS` | optional | `false` | Instance default for the PR scan webhook: set to `true` to scan pull requests from forks for every tracked repository that has no setting of its own. By default such deliveries are answered 200 and ignored. A repository's owner can opt out per tracked repository in Settings, or opt in on a private one (an `internal` repository counts as private) |

## GitHub OAuth (optional)

`make dev` works out of the box with the **Dev Login** on the login page (no GitHub credentials needed). For real GitHub login, register an OAuth app at [github.com/settings/developers](https://github.com/settings/developers) and add the two `GITHUB_CLIENT_*` values above:

```bash
cp .env.example .env
# add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env
make dev
```

## PR scan webhook (optional)

depsight can scan a pull request automatically and post (or update) its CVE comment, instead of only on the dashboard's PR scan button. It uses the same scan as `POST /api/pr-scan`.

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

```bash
make dev         # Start dev environment (foreground): app + Postgres via docker-compose.dev.yml
make dev-up      # Same as dev, but in background
make dev-down    # Stop dev environment
make dev-logs    # Tail dev logs
make dev-clean   # Stop + delete DB volumes (full reset)
make prod        # Production build + start
make test        # Run tests inside the dev container
make lint        # Lint + type-check inside the dev container
make ci          # Full CI pipeline
```

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

- The production deploy (`.relay.yml` `post_update`) runs
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
