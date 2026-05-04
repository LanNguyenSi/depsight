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

4. For Prisma schema changes, generate a migration and check it in alongside the schema edit.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/depsight.git
cd depsight
npm install
docker compose -f docker-compose.dev.yml up   # Postgres
npx prisma migrate dev
npm run dev
```

## Style

Match the surrounding code. Prefer small, reviewable diffs.
