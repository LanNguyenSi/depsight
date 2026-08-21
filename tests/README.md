# Tests

## Structure

```
tests/
├── unit/         # Unit tests for lib/, API routes, components
└── policy/       # Policy evaluation tests
```

## Running Tests

```bash
npm test              # full suite (vitest)
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

## Current Status

- ✅ CI pipeline configured (.github/workflows/ci.yml)
- ✅ Test framework (vitest; 60+ test files under tests/)
- ⏳ E2E tests (no Playwright setup and no `test:e2e` script yet)
