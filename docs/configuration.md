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

## GitHub OAuth (optional)

`make dev` works out of the box with the **Dev Login** on the login page (no GitHub credentials needed). For real GitHub login, register an OAuth app at [github.com/settings/developers](https://github.com/settings/developers) and add the two `GITHUB_CLIENT_*` values above:

```bash
cp .env.example .env
# add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env
make dev
```

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
npm run db:push        # Push schema changes (dev)
npm run db:studio      # Database GUI
```

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
