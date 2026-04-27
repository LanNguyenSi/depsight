# Configuration

## GitHub OAuth (optional)

`make dev` works out of the box with the **Dev Login** on the login page (no GitHub credentials needed). For real GitHub integration:

```bash
cp .env.example .env
# add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env
make dev
```

See `.env.example` for the full set of supported env vars.

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

## CI Health (ci-insights integration)

The **CI Health** tab in the dashboard surfaces GitHub Actions analytics (fail rates, build times, flaky jobs) powered by [ci-insights](https://github.com/LanNguyenSi/ci-insights), a companion service that syncs and stores workflow data from GitHub Actions.

> The tab is only visible once CI data has been synced. depsight works fully without ci-insights; the CI Health tab simply won't appear if no data has been synced.

### Setup

1. Deploy [ci-insights](https://github.com/LanNguyenSi/ci-insights) and configure your GitHub token.
2. Run a sync for the repository.
3. The CI Health tab appears automatically in depsight once data is available.

To trigger a sync manually via the depsight API:

```bash
curl -X POST https://<your-depsight>/api/ci/sync \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"repoId": "<repo-id>"}'
```
