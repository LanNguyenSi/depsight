import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/__tests__/**", "dist/**", "src/index.ts"],
      thresholds: {
        // Global floor — set a few points below the measured baseline
        // (statements 100 / branches 95 / functions 100 / lines 100, after
        // the client.test.ts additions below) so the current suite passes
        // but a significant regression fails CI.
        // The functions floor was previously slack at 83 because
        // src/client.ts had several methods (getOverview, getScan, getDeps,
        // getLicense, getCiAnalyticsCrossRepo) that were only exercised
        // indirectly (via mocked DepsightClient in the tool-surface tests).
        // client.test.ts now directly covers each of those methods'
        // request + HttpError branches, so the floor is raised toward the
        // measured 100%.
        statements: 92,
        branches: 90,
        functions: 95,
        lines: 92,
        // Per-file floors for the tool-handler + server-wiring slice
        // (2026-07-01, slice 3/3). Measured S/B/F/L: shared 100/100/100/100,
        // cves 100/93.1/100/100, repos 100/100/100/100, deps 100/100/100/100,
        // license 100/100/100/100, history 100/100/100/100,
        // policy 100/100/100/100, ci 100/100/100/100, sbom 100/100/100/100,
        // server 100/100/100/100, rescan 100/100/100/100. Floors set 3-5
        // points below measured.
        // Negative-control verified: one floor was temporarily raised above
        // measured, confirmed ERROR, then restored.
        // client.ts added 2026-07-04 (direct coverage of getOverview,
        // getScan, getDeps, getLicense, getCiAnalyticsCrossRepo request +
        // error branches). Measured S/B/F/L: 100/92.3/100/100. Floors set
        // 3-5 points below measured. Negative-control verified separately.
        "src/client.ts": {
          statements: 96,
          branches: 88,
          functions: 96,
          lines: 96,
        },
        "src/tools/shared.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/cves.ts": {
          statements: 95,
          branches: 88,
          functions: 95,
          lines: 95,
        },
        "src/tools/repos.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/deps.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/license.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/history.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/policy.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/ci.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/sbom.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/tools/rescan.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/server.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
