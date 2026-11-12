# Tests

## Structure

```
tests/
├── unit/         # Unit tests for lib/, API routes and a few server-rendered components
├── policy/       # Policy evaluation tests
└── fixtures/     # Test fixtures: schema-before-advisory-key.prisma (an earlier Prisma
                  # schema) and restore-drill-rich.sql (a dump with awkward content that
                  # scripts/restore-drill.sh loads, see docs/configuration.md)
```

## Running Tests

```bash
npm test              # full suite (vitest)
npm run test:watch    # watch mode
npm run test:coverage # with coverage and the global and per-file coverage floors CI enforces
```

`tests/unit/advisory-dedupe-db.test.ts` and `tests/unit/api-token-hash-db.test.ts` each have a database half that needs a real Postgres (CI runs both files in the `Advisory dedupe (Postgres)` job). That half is skipped unless `DEPSIGHT_TEST_DATABASE_URL` points at a server; each case works in its own schema of that database and drops it afterwards. With `make dev-up` running, for example:

```bash
DEPSIGHT_TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/depsight_dev npx vitest run tests/unit/advisory-dedupe-db.test.ts tests/unit/api-token-hash-db.test.ts
```

`tests/unit/narrow-npm-workspaces-npm-oracle.test.ts` runs the real `npm` on PATH (about 35 runs of `npm install --package-lock-only --offline` and `npm query`, several seconds) to check the npm workspace proof against npm's own workspace list. It needs no network. Locally it is skipped unless `DEPSIGHT_NPM_ORACLE=1`; the CI test job runs it (`CI` set turns it on, and the job sets `DEPSIGHT_NPM_ORACLE=1` too), and `DEPSIGHT_NPM_ORACLE=0` skips it anywhere:

```bash
DEPSIGHT_NPM_ORACLE=1 npx vitest run tests/unit/narrow-npm-workspaces-npm-oracle.test.ts
```

`tests/unit/narrow-npm-workspace-patterns-npm.test.ts` loads `@npmcli/map-workspaces` from the npm on PATH (`npm root -g`) and runs by default; locally it is skipped when that npm cannot be found, and with `CI` set it fails instead of skipping.

## Current Status

- ✅ CI pipeline configured (.github/workflows/ci.yml)
- ✅ Test framework (vitest; test files under tests/)
- ⏳ E2E tests (no Playwright setup and no `test:e2e` script yet)
