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
      include: ['lib/**/*.ts', 'app/api/**/*.ts', 'scripts/**/*.ts'],
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
        // Raised (2026-07-01, server-side lib slice 2/3): the DB-loading half
        // of repo-bundle.ts (loadRepoExportData + private loaders) is now
        // covered by tests/unit/repo-bundle-loaders.test.ts. Measured
        // S/B/F/L: 100/93.75/100/100. Floor set 3-5 points below measured.
        // Negative-control verified (raise above measured -> ERROR).
        'lib/export/repo-bundle.ts': {
          statements: 95,
          branches: 89,
          functions: 95,
          lines: 95,
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
        // Per-file floors for the CI-analytics lib modules (2026-07-01).
        // Measured S/B/F/L: bottleneck 97.22/86.66/100/100, build-times
        // 93.61/84.21/100/100, cross-repo 100/95.83/100/100, fail-rate
        // 100/100/100/100, flaky 92.59/85.36/100/97.82. Floors set 3-5 points
        // below measured. Negative-control verified (raise a floor above
        // measured -> ERROR) before setting the final values.
        'lib/ci/analytics/bottleneck.ts': {
          statements: 93,
          branches: 82,
          functions: 96,
          lines: 96,
        },
        'lib/ci/analytics/build-times.ts': {
          statements: 89,
          branches: 80,
          functions: 96,
          lines: 96,
        },
        'lib/ci/analytics/cross-repo.ts': {
          statements: 96,
          branches: 91,
          functions: 96,
          lines: 96,
        },
        'lib/ci/analytics/fail-rate.ts': {
          statements: 96,
          branches: 96,
          functions: 96,
          lines: 96,
        },
        'lib/ci/analytics/flaky.ts': {
          statements: 88,
          branches: 81,
          functions: 96,
          lines: 93,
        },
        // Per-file floors for the server-side lib layer (2026-07-01,
        // server-side lib slice 2/3): CI ingestion, the auto-scan worker,
        // PR scanning, and the Octokit wrapper. Measured S/B/F/L: sync
        // 100/100/100/100, ingest 97.5/67.74/100/100, auto-scan
        // 88.23/81.81/83.33/90.47, pr-scanner 100/87.5/100/100, github
        // 100/100/100/100. Floors set 3-5 points below measured.
        // Negative-control verified (raise a floor above measured -> ERROR)
        // before setting the final values.
        'lib/ci/sync.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        'lib/ci/ingest.ts': {
          statements: 93,
          branches: 63,
          functions: 95,
          lines: 95,
        },
        'lib/cron/auto-scan.ts': {
          statements: 84,
          branches: 77,
          functions: 79,
          lines: 86,
        },
        'lib/pr/pr-scanner.ts': {
          statements: 95,
          branches: 83,
          functions: 95,
          lines: 95,
        },
        'lib/github.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        // scripts/mint-api-token.ts: measured S/B/F/L 83.33/75/50/81.48.
        // Function coverage caps at 50% because the `require.main === module`
        // entry-point guard's .catch()/.finally() callbacks only run when the
        // script is the process entry point (`npx tsx scripts/mint-api-token.ts`),
        // never when imported by a test — that path is intentionally not
        // exercised here (it would require spawning a real subprocess against
        // a real database). Floor set 3-5 points below measured.
        'scripts/mint-api-token.ts': {
          statements: 79,
          branches: 70,
          functions: 45,
          lines: 77,
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
