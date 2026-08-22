# Contributing to depsight

Thanks for your interest. depsight is a GitHub-connected developer security dashboard for CVE tracking, license compliance, and dependency health. Live: [depsight.opentriologue.ai](https://depsight.opentriologue.ai).

## Issues

- Bug reports: include repro steps, expected vs. actual, the affected surface (Next.js UI, API routes, MCP server, runner, Prisma schema, hosted instance).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks:

   ```bash
   npm install
   npx prisma generate    # required before build on a fresh clone
   npm run build
   npm test
   ```

4. For Prisma schema changes, edit `prisma/schema.prisma`; the schema is applied with `prisma db push` (no migrations directory).
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/depsight.git
cd depsight
docker compose -f docker-compose.dev.yml up   # or: make dev (adds --build)
```

The `app` container's entrypoint (`docker/entrypoint.dev.sh`) already runs
`npm install`, `npx prisma generate`, and `npx prisma db push` against the
`db` service before starting `npm run dev`, so no host-side install or push
step is needed for this flow. A host-side `npx prisma db push` is only
needed if you run Prisma commands directly against Postgres from the host
(outside the `app` container); in that case set `DATABASE_URL` in `.env` to
match the `db` service's credentials (`postgresql://dev:dev@localhost:5432/depsight_dev`).
The `.env.example` default is a production-style placeholder and matches
neither the dev compose credentials nor the other compose files.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
