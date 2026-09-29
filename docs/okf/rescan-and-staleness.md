---
type: module
title: Rescan and staleness - per-scanner freshness beside one any-success timestamp
description: staleness has no dedicated flag on Repo or Scan; the cron computes it each cycle from two Repo fields, lastScannedAt (the last time any scanner succeeded, written only by the three scanners) and lastScanAttemptAt (the cron's own attempt marker), while per-scanner freshness (cveScannedAt, licenseScannedAt, depsScannedAt plus a last-failure message each) lets a persistently failing scanner stay visible in the overview table and the dashboard even when the other scanners keep advancing lastScannedAt; the cron no longer stamps lastScannedAt after a failed attempt; a scanner whose source could not be read (revoked token, GitHub or OSV outage) still stores what it found but is recorded through the same error field instead of stamping a success.
tags: [cron, scan, staleness, mcp]
timestamp: 2026-09-29T10:26:47Z
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
  - lib/scan/degraded.ts
  - lib/cve/osv.ts
  - lib/manifest-discovery.ts
  - lib/license/detector.ts
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

Each scanner writes its own fields inside the same transaction that marks its scan COMPLETED. When every source it read was readable it writes `scanSuccessData` (`lib/scan/freshness.ts:37-46`): `lib/cve/scanner.ts:142-147`, `lib/license/scanner.ts:54-57` and `lib/deps/scanner.ts:64-67`. That advances its own timestamp and `lastScannedAt` and clears its own error, and touches nothing of the other two scanners. When a source could not be read it writes `scanDegradedData` instead (`lib/scan/freshness.ts:71-73`, next section). When a scanner throws, its catch block calls `recordScanFailure` (`lib/scan/record-failure.ts:9-15`, `lib/scan/freshness.ts:52-62`), which writes only that scanner's error message and no timestamp: `lib/cve/scanner.ts:172-174`, `lib/license/scanner.ts:71-73`, `lib/deps/scanner.ts:81-83`. The dependency-age scanner also records a failure from `analyzeDepAge`, which runs before its scan row exists (`lib/deps/scanner.ts:20-33`). The scanners' own callers are unchanged: the cron loop, `POST /api/scan`, `POST /api/license` at `app/api/license/route.ts:30`, `POST /api/deps` at `app/api/deps/route.ts:48`, and `POST /api/export` for missing scans.

## A source that could not be read is a degraded run, not a success

The scanners used to count a source they could not read as "read, nothing found": a revoked GitHub token or an outage of GitHub or OSV ended in a COMPLETED scan with nothing found, which stamped the success time and cleared the error. Sources now report the difference through `lib/scan/degraded.ts`. `noteDegraded` records an unreadable source and does nothing outside a scope (`lib/scan/degraded.ts:59-69`), so readers that never call a noting source are unaffected (PR scanning via `fetchRepoAdvisories`, SBOM, the export bundle reader), while the export route's on-demand scans (`app/api/export/route.ts:43-73`) are tracked like any other scan. `trackDegraded` opens the scope (`lib/scan/degraded.ts:99-105`); it is an AsyncLocalStorage store, so the leaf readers need no signature change and the three scanners the cron runs in parallel each see only their own reads. `isNothingThere` defines the empty-by-design answer: a 404, or the 409 GitHub answers for the git tree of a repository with no commit (`lib/scan/degraded.ts:44-49`). Everything else is unreadable: 401, 403 (a rate limit included), 429, 5xx, a network error, a timeout; the one mapped exception is the Dependabot 403 below.

Each scanner reads its sources inside that scope (`lib/cve/scanner.ts:74-96`, `lib/license/scanner.ts:26-28`, `lib/deps/scanner.ts:27-29`). When the scope reports a reason, the scanner still stores what it found and completes its scan row, but writes `scanDegradedData` instead of `scanSuccessData`: the same per-scanner error column a thrown scan uses, holding the reasons behind the prefix `Source unreadable, result may be incomplete`, with no success timestamp and no `lastScannedAt`. The overview marker and the dashboard line show it unchanged, and the next run that reads every source clears it. The sources that report:

- The Dependabot fetch: any failure other than the two answers `fetchRepoAdvisories` already maps to "Dependabot alerts not enabled" (a 404, or a 403 that is not a rate limit), which stays empty by design and a success (`lib/cve/scanner.ts:80-86`).
- OSV: a querybatch that answers non-OK or fails outright (`lib/cve/osv.ts:609-621`), a vulnerability whose detail cannot be read (`lib/cve/osv.ts:650-662`), a failed dependency collection, a failed lockfile resolution that falls back to the manifest floor, and the outer handler (`lib/cve/osv.ts:574-578`, `lib/cve/osv.ts:435-444`, `lib/cve/osv.ts:488-491`, `lib/cve/osv.ts:705-708`).
- Manifest discovery, shared by all three scanners because the license and dependency-age scanners and every per-ecosystem manifest reader go through it: the git tree read (`lib/manifest-discovery.ts:308-315`), the root listing fallback (`lib/manifest-discovery.ts:1070-1084`) and each file read (`lib/manifest-discovery.ts:377-382`). A missing manifest or lockfile is a 404 there and stays "not there"; a malformed manifest is repository content and is skipped, not reported.
- A repository that is gone or hidden from the token. GitHub then answers 404 on the tree, the root listing and the license lookup, and Dependabot reads as "not enabled", which alone would look like a repository with nothing in it. When the git tree or the root listing answers 404, `confirmRepositoryReadable` (`lib/scan/degraded.ts:80-92`, called from `lib/manifest-discovery.ts:313` and `lib/manifest-discovery.ts:1082`) reads the repository itself with `repos.get`; a 404 there notes `repository not readable`, so all three scanners end degraded, while a 200 leaves the empty result a success (a repository that exists without manifests). The lookup is memoized inside the tracking scope, so it runs at most once per scan however many 404 paths ask, and not at all outside a scope. A lookup that fails with anything but 404 is noted under its own error, like any other unreadable source. The 409 tree read of an empty repository does not trigger it by itself, but that repository's root listing then answers 404 and runs one lookup per scan (which answers 200, so the scan stays a success); a 404 on a single file or on the license lookup does not trigger it.
- The license scanner's repository-level license lookup, where a 404 means "no license file" and anything else is reported (`lib/license/detector.ts:66-74`, and the outer 403 at `lib/license/detector.ts:139-142`).

A per-package registry lookup that fails (npm, PyPI, crates.io, Packagist, Maven, the Go proxy) is not reported: it stays a per-row unknown or needs-review entry, visible on that package. Retries, the scan cadence and the scanner set are unchanged, and `POST /api/scan` still answers `completed` for a degraded scan.

The cron is no longer a writer of `lastScannedAt`. After running the three scanners for a repo with `Promise.allSettled` and logging a warning for each rejection (`lib/cron/auto-scan.ts:94-112`), it writes only `lastScanAttemptAt`, gated on the batch not being rate-limited (`lib/cron/auto-scan.ts:114-119`). A repo whose three scanners all threw therefore keeps its old `lastScannedAt` and per-scanner timestamps and gains three error messages.

## What the UI shows

`getScannerStatuses` (`lib/scan/freshness.ts:75-81`) turns the six per-scanner columns into a `{ lastSuccessAt, error }` pair per scanner, and `failingScanners` (`lib/scan/freshness.ts:84-86`) lists the ones with an error. The overview table shows the `lastScannedAt` date plus a warning marker whose tooltip names each failing scanner, its message and its last success (`components/overview/RepoComparisonTable.tsx:183-195`, fed by `lib/overview/team-health.ts:161`), and sorts its "scanned" column by `lastScannedAt` (`components/overview/RepoComparisonTable.tsx:45-49`). The dashboard header shows the same per scanner as a red line under "last scanned" (`app/dashboard/DashboardClient.tsx:943-955`), from the server-rendered status (`app/dashboard/page.tsx:67`); it is not refreshed after an in-page rescan until the page is reloaded. In the dashboard, the "last scanned" time itself is overwritten client-side from the latest completed scan rows (`app/dashboard/DashboardClient.tsx:352`, `app/dashboard/DashboardClient.tsx:365`), so it reflects completed scans, not attempts.

## Consequence

Before this split, `lastScannedAt` answered "was this repo attempted recently", and a failing scanner's stale deps, license or CVE data hid behind it. Now `lastScannedAt` answers "did anything succeed recently", which is still not "are all three scan types current"; the per-scanner fields answer that, and a scanner that keeps failing, or keeps running against a source it cannot read, while the others succeed is visible through its error and its old success time. The cadence is unchanged: `SCAN_INTERVAL_MINUTES` still sets the interval, and a repo is attempted at most once per interval whether or not its scanners succeed.
