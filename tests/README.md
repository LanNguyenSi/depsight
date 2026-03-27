# Tests

## Structure

```
tests/
├── unit/         # Unit tests for lib/, components/
├── integration/  # API route tests
└── e2e/          # End-to-end tests (Playwright)
```

## Running Tests

```bash
# Unit + Integration tests (to be added in Wave 2-3)
npm test

# E2E tests (to be added in Wave 4)
npm run test:e2e
```

## Current Status

- ✅ CI pipeline configured (.github/workflows/ci.yml)
- ⏳ Test framework setup (Task 013 - Wave 4)
- ⏳ Test coverage baseline (Task 013 - Wave 4)
