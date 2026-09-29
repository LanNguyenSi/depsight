---
type: module
title: Rescan and staleness - per-scanner freshness beside one any-success timestamp
description: staleness has no dedicated flag on Repo or Scan; the cron computes it each cycle from two Repo fields, lastScannedAt (the last time any scanner succeeded, written only by the three scanners) and lastScanAttemptAt (the cron's own attempt marker), while per-scanner freshness (cveScannedAt, licenseScannedAt, depsScannedAt plus a last-failure message each) lets a persistently failing scanner stay visible in the overview table and the dashboard even when the other scanners keep advancing lastScannedAt; the cron no longer stamps lastScannedAt after a failed attempt.
tags: [cron, scan, staleness, mcp]
timestamp: 2026-09-29T06:00:48Z
sources:
  - lib/cron/auto-scan.ts
  - lib/cve/scanner.ts
  - lib/license/scanner.ts
  - lib/deps/scanner.ts
  - mcp/src/tools/rescan.ts
  - mcp/src/client.ts
  - prisma/schema.prisma
  - docs/configuration.md
  - app/api/export/route.ts
  - components/overview/RepoComparisonTable.tsx
  - lib/scan/freshness.ts
  - lib/scan/record-failure.ts
  - lib/overview/team-health.ts
  - app/dashboard/DashboardClient.tsx
  - app/dashboard/page.tsx
  - lib/export/repo-bundle.ts
  - app/api/license/route.ts
  - app/api/deps/route.ts
---

## Three trigger paths, one underlying pipeline

A rescan reaches the same CVE scan pipeline three ways: `POST /api/scan`, called directly by the dashboard's rescan action and by the MCP `depsight_rescan` tool (`mcp/src/tools/rescan.ts:10-47` via `mcp/src/client.ts:135-137`), runs `scanRepository()` synchronously for one repo. `POST /api/export` runs a scanner only for a scan type with no completed scan to export (`getMissingExportScans`, `lib/export/repo-bundle.ts:166-172`; for CVE and license that means no COMPLETED scan with a payload, `:56-58`, `:79-81`; for deps, no candidate among the 20 most recent COMPLETED scans, `:113-132`), and only when the request sets `runMissingScans`; otherwise it answers 409 `missing_scans` (`app/api/export/route.ts:33-73`). An export of a repo that has a usable completed scan of every type does not rescan anything; a repo whose scans all failed, or whose last usable deps scan fell out of that 20-scan window, does get rescanned. The auto-scan cron (`lib/cron/auto-scan.ts`) runs on an interval read from `SCAN_INTERVAL_MINUTES` (default 60, documented in `docs/configuration.md`) and, for each stale repo, runs all three scanners (CVE, license, and dependency age) in parallel via `Promise.allSettled` (`lib/cron/auto-scan.ts:94-98`).

## "Stale" is computed, not stored

Neither `Repo` (`prisma/schema.prisma:30-74`) nor `Scan` (`prisma/schema.prisma:76-108`) carries a dedicated staleness flag or expiry timestamp. The cron computes it fresh every cycle: `staleThreshold = now - SCAN_INTERVAL_MINUTES`, then selects tracked repos where BOTH `lastScannedAt` and `lastScanAttemptAt` are null or older than the threshold (`lib/cron/auto-scan.ts:64-72`). The gate keys off "last touched", success or attempt, on purpose: it answers "is this repo due for another try", so a repo whose scanners keep failing is retried at the normal cadence instead of every cycle, and a repo that a manual scan just refreshed is skipped. Per-scanner staleness is not used by the gate; it is a display concern (below).

## Which field means what

- `Repo.lastScannedAt` (`prisma/schema.prisma:49`) is the last time ANY of the three scanners completed successfully. Only the scanners write it. It says nothing about the other two scanners.
- `Repo.lastScanAttemptAt` (`prisma/schema.prisma:53`) is the cron's own attempt marker, written after each non-rate-limited attempt (`lib/cron/auto-scan.ts:114-119`) whether or not any scanner succeeded. Nothing in the UI reads it; only the due-gate does.
- `Repo.cveScannedAt`, `licenseScannedAt`, `depsScannedAt` (`prisma/schema.prisma:57-59`) are per-scanner last-success times. They stay null until that scanner first succeeds after the columns existed (no backfill).
- `Repo.cveScanError`, `licenseScanError`, `depsScanError` (`prisma/schema.prisma:62-64`) hold the scanner's last failure message, capped at 500 characters, and are cleared by that scanner's next success; non-null means "currently failing".

## Writers

Each scanner writes its own fields inside the same transaction that marks its scan COMPLETED, through `scanSuccessData` (`lib/scan/freshness.ts:37-46`): `lib/cve/scanner.ts:131-135`, `lib/license/scanner.ts:49-52` and `lib/deps/scanner.ts:58-61`. That advances its own timestamp and `lastScannedAt` and clears its own error, and touches nothing of the other two scanners. When a scanner throws, its catch block calls `recordScanFailure` (`lib/scan/record-failure.ts:9-15`, `lib/scan/freshness.ts:52-62`), which writes only that scanner's error message and no timestamp: `lib/cve/scanner.ts:160-162`, `lib/license/scanner.ts:66-68`, `lib/deps/scanner.ts:75-77`. The dependency-age scanner also records a failure from `analyzeDepAge`, which runs before its scan row exists (`lib/deps/scanner.ts:19-27`). The CVE scanner swallows a Dependabot fetch failure and completes on OSV alone, so that case is a success, not a failure marker (`lib/cve/scanner.ts:71-78`). Known limitation: the CVE failure marker therefore does not fire for a source outage. `fetchOsvAdvisories` never throws (`lib/cve/scanner.ts:79-85`; its outer handler returns empty advisories, `lib/cve/osv.ts:687-690`), so a revoked GitHub token or an outage of both sources ends in a COMPLETED scan with zero advisories, which stamps `cveScannedAt` and clears `cveScanError`; the overview and the dashboard then show the CVE scan as healthy while it is blind. The license and dependency-age scanners have the same blindness: manifest discovery swallows GitHub errors (`lib/manifest-discovery.ts:371-373`, `lib/manifest-discovery.ts:1061-1062`), so `analyzeDepAge` returns an empty result (`lib/deps/age-checker.ts:115`), and the repository-level license lookup swallows its error too (`lib/license/detector.ts:98-103`); with a revoked token or a GitHub outage both scanners complete with nothing found, stamp their success time and clear their error. For all three scanners, the failure marker fires only when the scanner itself throws. The CVE marker only fires when the scanner itself throws, for example when the advisory transaction rejects (`lib/cve/scanner.ts:94-136`). Marking a degraded source is not part of this change. The scanners' own callers are unchanged: the cron loop, `POST /api/scan`, `POST /api/license` at `app/api/license/route.ts:30`, `POST /api/deps` at `app/api/deps/route.ts:48`, and `POST /api/export` for missing scans.

The cron is no longer a writer of `lastScannedAt`. After running the three scanners for a repo with `Promise.allSettled` and logging a warning for each rejection (`lib/cron/auto-scan.ts:94-112`), it writes only `lastScanAttemptAt`, gated on the batch not being rate-limited (`lib/cron/auto-scan.ts:114-119`). A repo whose three scanners all threw therefore keeps its old `lastScannedAt` and per-scanner timestamps and gains three error messages.

## What the UI shows

`getScannerStatuses` (`lib/scan/freshness.ts:64-70`) turns the six per-scanner columns into a `{ lastSuccessAt, error }` pair per scanner, and `failingScanners` (`lib/scan/freshness.ts:73-75`) lists the ones with an error. The overview table shows the `lastScannedAt` date plus a warning marker whose tooltip names each failing scanner, its message and its last success (`components/overview/RepoComparisonTable.tsx:183-195`, fed by `lib/overview/team-health.ts:161`), and sorts its "scanned" column by `lastScannedAt` (`components/overview/RepoComparisonTable.tsx:45-49`). The dashboard header shows the same per scanner as a red line under "last scanned" (`app/dashboard/DashboardClient.tsx:943-955`), from the server-rendered status (`app/dashboard/page.tsx:67`); it is not refreshed after an in-page rescan until the page is reloaded. In the dashboard, the "last scanned" time itself is overwritten client-side from the latest completed scan rows (`app/dashboard/DashboardClient.tsx:352`, `app/dashboard/DashboardClient.tsx:365`), so it reflects completed scans, not attempts.

## Consequence

Before this split, `lastScannedAt` answered "was this repo attempted recently", and a failing scanner's stale deps, license or CVE data hid behind it. Now `lastScannedAt` answers "did anything succeed recently", which is still not "are all three scan types current"; the per-scanner fields answer that, and a scanner that keeps failing while the others succeed is visible through its error and its old success time. The cadence is unchanged: `SCAN_INTERVAL_MINUTES` still sets the interval, and a repo is attempted at most once per interval whether or not its scanners succeed.
