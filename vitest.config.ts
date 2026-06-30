import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['lib/**/*.ts', 'app/api/**/*.ts'],
      exclude: ['lib/**/*.d.ts'],
      thresholds: {
        // Global floor — ~2 points below the measured baseline (39.27/34.83/42.07/39.5)
        // so the current suite passes but any significant regression fails CI.
        statements: 37,
        branches: 32,
        functions: 40,
        lines: 37,
        // Per-file high floors for the newly-covered security files.
        'lib/net/safe-fetch.ts': {
          statements: 90,
          branches: 83,
          functions: 90,
          lines: 90,
        },
        'app/api/tokens/route.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'app/api/tokens/[id]/route.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'app/api/webhooks/route.ts': {
          statements: 90,
          branches: 85,
          functions: 95,
          lines: 90,
        },
        'app/api/policies/route.ts': {
          statements: 95,
          branches: 88,
          functions: 95,
          lines: 95,
        },
        // Per-file floors added by the coverage-residual batch (2026-06-29).
        // Measured then set 3-5 points below to absorb noise.
        // Negative-control verified: each floor was temporarily raised above measured;
        // all 6 triggered ERROR before being restored.
        'app/api/slack/route.ts': {
          statements: 95,
          branches: 88,
          functions: 95,
          lines: 95,
        },
        'app/api/policies/[id]/route.ts': {
          statements: 90,
          branches: 88,
          functions: 95,
          lines: 90,
        },
        'app/api/webhooks/[id]/route.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'app/api/scan/route.ts': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
        'lib/export/repo-bundle.ts': {
          statements: 55,
          branches: 33,
          functions: 65,
          lines: 55,
        },
        'lib/policy/service.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        // Per-file floors added by the route-coverage batch (2026-06-30):
        // the remaining 18 untested route handlers. Measured S/F/L=100 across
        // the board (floor 95); branch floors set ~5-8 points below measured.
        // Negative-control verified before PR (raise a floor above measured -> ERROR).
        'app/api/dependabot/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/dependabot/check/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/dependabot/enable-all/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/ci/sync/route.ts': {
          statements: 95,
          branches: 80,
          functions: 95,
          lines: 95,
        },
        'app/api/repos/sync/route.ts': {
          statements: 95,
          branches: 68,
          functions: 95,
          lines: 95,
        },
        'app/api/pr-scan/route.ts': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
        'app/api/export/route.ts': {
          statements: 95,
          branches: 78,
          functions: 95,
          lines: 95,
        },
        'app/api/sbom/route.ts': {
          statements: 95,
          branches: 82,
          functions: 95,
          lines: 95,
        },
        'app/api/me/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/health/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/deps/route.ts': {
          statements: 95,
          branches: 88,
          functions: 95,
          lines: 95,
        },
        'app/api/license/route.ts': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
        'app/api/ci/analytics/[repoId]/route.ts': {
          statements: 95,
          branches: 80,
          functions: 95,
          lines: 95,
        },
        'app/api/ci/analytics/cross-repo/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/history/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'app/api/overview/route.ts': {
          statements: 95,
          branches: 68,
          functions: 95,
          lines: 95,
        },
        'app/api/policies/evaluate/route.ts': {
          statements: 95,
          branches: 80,
          functions: 95,
          lines: 95,
        },
        'app/api/repos/route.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
});
