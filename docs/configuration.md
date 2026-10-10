# Configuration

## Environment variables

`.env.example` ships the full set; copy it to `.env` and fill in values before `make dev`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgresql://depsight:password@localhost:5432/depsight` | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | yes | (none) | NextAuth session signing secret. Generate with `openssl rand -base64 32` |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` | Public base URL of the app |
| `GITHUB_CLIENT_ID` | optional | (none) | GitHub OAuth client id. Only needed for real GitHub login (the **Dev Login** button works without it) |
| `GITHUB_CLIENT_SECRET` | optional | (none) | GitHub OAuth client secret. Pair with `GITHUB_CLIENT_ID` |
| `SCAN_INTERVAL_MINUTES` | optional | `60` | Minutes between automatic background re-scans (auto-scan cron) |
| `GITHUB_WEBHOOK_SECRET` | optional | (none) | Shared secret of the GitHub pull-request webhook. Unset or blank disables `POST /api/webhooks/github` (it answers 503 and scans nothing). Generate with `openssl rand -hex 32` |
| `GITHUB_WEBHOOK_SCAN_FORKS` | optional | `false` | Set to `true` to let the PR scan webhook scan pull requests from forks. By default such deliveries are answered 200 and ignored |

## GitHub OAuth (optional)

`make dev` works out of the box with the **Dev Login** on the login page (no GitHub credentials needed). For real GitHub login, register an OAuth app at [github.com/settings/developers](https://github.com/settings/developers) and add the two `GITHUB_CLIENT_*` values above:

```bash
cp .env.example .env
# add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env
make dev
```

## PR scan webhook (optional)

depsight can scan a pull request automatically and post (or update) its CVE comment, instead of only on the dashboard's PR scan button. It uses the same scan as `POST /api/pr-scan`.

1. Set `GITHUB_WEBHOOK_SECRET` in `.env` (for example the output of `openssl rand -hex 32`) and restart the app. While it is unset the endpoint answers 503.
2. In the GitHub repository (or organisation) go to Settings, Webhooks, Add webhook:
   - **Payload URL:** `<NEXTAUTH_URL>/api/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
   - **Events:** "Let me select individual events", then only **Pull requests**. GitHub also sends a `ping` event when the webhook is created; depsight answers it 200.
3. The repository must be tracked in depsight. A delivery for any other repository is answered 200 and ignored.

**Trust model.** `GITHUB_WEBHOOK_SECRET` is instance-wide. Whoever holds it can sign deliveries for any repository tracked by any depsight user, and depsight then scans the pull request and posts the comment with that tracking user's GitHub token. On a multi-user instance keep the secret operator-only and add the webhook only to repositories the operator controls; otherwise leave the variable unset (the endpoint stays disabled) or use it on a single-user instance only. On a public repository the comment is public; fork pull requests are skipped unless opted in (below).

**Fork pull requests are skipped by default.** A delivery whose `pull_request.head.repo.full_name` differs from `repository.full_name` (compared case-insensitively; a deleted fork, where `head.repo` is null, counts as a fork) is answered 200 `ignored` after the signature check and before any database lookup or rate-limit budget. The default is to skip because on a public repository anyone can open a fork pull request, and the scan comment publishes Dependabot alert data (open alert count, risk score, new alerts) and spends the repository's scan budget. Set `GITHUB_WEBHOOK_SCAN_FORKS=true` only for repositories where fork contributors are trusted (for example a private repository).

Only the `opened` and `synchronize` actions of `pull_request` start a scan (`reopened` does not); every other event or action is answered 200 and ignored. The scan runs in the background after a `202` answer and authenticates with the GitHub token of the user who tracks the repository (the oldest tracking row with a stored token, as the auto-scan cron does). See [API reference](api.md#github-pull-request-webhook) for the status codes, the replay protection and the limits.

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
