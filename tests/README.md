# Tests

## Structure

```
tests/
├── unit/         # Unit tests for lib/, API routes and a few server-rendered components
├── policy/       # Policy evaluation tests
└── fixtures/     # Test fixtures (an earlier Prisma schema)
```

## Running Tests

```bash
npm test              # full suite (vitest)
npm run test:watch    # watch mode
npm run test:coverage # with coverage and the global and per-file coverage floors CI enforces
```

`tests/unit/advisory-dedupe-db.test.ts` has a part that needs a real Postgres. It is skipped unless `DEPSIGHT_TEST_DATABASE_URL` points at a server; each case works in its own schema of that database and drops it afterwards. With `make dev-up` running, for example:

```bash
DEPSIGHT_TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/depsight_dev npx vitest run tests/unit/advisory-dedupe-db.test.ts
```

## Current Status

- ✅ CI pipeline configured (.github/workflows/ci.yml)
- ✅ Test framework (vitest; test files under tests/)
- ⏳ E2E tests (no Playwright setup and no `test:e2e` script yet)
