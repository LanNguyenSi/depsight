---
type: module
title: Rescan and staleness - one shared timestamp, four independent writers
description: staleness has no dedicated field on Repo or Scan; it is computed fresh each cron cycle from Repo.lastScannedAt, a single field written both by the three individual scanners on success and, separately, by the cron loop itself after every non-rate-limited attempt regardless of whether any scanner succeeded, so lastScannedAt can advance with zero successful scans; a persistently failing scanner keeps being retried at the same cadence as a healthy repo, but its stale deps/license/CVE data hides behind a lastScannedAt that always looks current in surfaces like the dashboard and RepoComparisonTable.
tags: [cron, scan, staleness, mcp]
timestamp: 2026-09-27T14:58:04Z
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
  - lib/export/repo-bundle.ts
  - app/api/license/route.ts
  - app/api/deps/route.ts
---

## Three trigger paths, one underlying pipeline

A rescan reaches the same CVE scan pipeline three ways: `POST /api/scan`, called directly by the dashboard's rescan action and by the MCP `depsight_rescan` tool (`mcp/src/tools/rescan.ts:10-47` via `mcp/src/client.ts:135-137`), runs `scanRepository()` synchronously for one repo. `POST /api/export` runs a scanner only for a scan type the repo has no scan of yet (`getMissingExportScans`, `lib/export/repo-bundle.ts:166-172`), and only when the request sets `runMissingScans`; otherwise it answers 409 `missing_scans` (`app/api/export/route.ts:33-73`). An export of an already-scanned repo does not rescan anything. The auto-scan cron (`lib/cron/auto-scan.ts`) runs on an interval read from `SCAN_INTERVAL_MINUTES` (default 60, documented in `docs/configuration.md`) and, for each stale repo, runs all three scanners (CVE, license, and dependency age) in parallel via `Promise.allSettled` (`lib/cron/auto-scan.ts:90-94`).

## "Stale" is computed, not stored

Neither `Repo` (`prisma/schema.prisma:30-53`) nor `Scan` (`prisma/schema.prisma:55-87`) carries a dedicated staleness flag or expiry timestamp. The cron computes staleness fresh every cycle: `staleThreshold = now - SCAN_INTERVAL_MINUTES`, then selects repos where `lastScannedAt IS NULL OR lastScannedAt < staleThreshold` (`lib/cron/auto-scan.ts:59-68`). `Repo.lastScannedAt` (`prisma/schema.prisma:44`) is the only persisted signal this check has.

## One field, four independent writers

That single field has four independent writers, not three. Each of the three scanners writes it inside its own database transaction, whenever that specific scanner completes without throwing: `lib/cve/scanner.ts:130-133`, `lib/license/scanner.ts:47-50`, and `lib/deps/scanner.ts:48-51` each run their own `tx.repo.update({ where: { id: repoId }, data: { lastScannedAt: new Date() } })`. None of the three checks whether the other two also succeeded.

The cron loop itself is a fourth, separate writer. After running the three scanners for a repo with `Promise.allSettled` and only logging a warning for whichever ones rejected (`lib/cron/auto-scan.ts:90-105`), it writes `lastScannedAt` again on its own, gated only on the batch not being rate-limited, not on any scanner having succeeded: `if (!rateLimited) { await prisma.repo.update({ where: { id: repo.id }, data: { lastScannedAt: new Date() } }); }` (`lib/cron/auto-scan.ts:107-112`). This write happens even when all three `Promise.allSettled` results for that repo were rejections.

`Repo.lastScannedAt` therefore reflects whichever is later: the last non-rate-limited cron attempt for that repo, or the last individual scanner success, from any caller of the three scanners (each scanner writes the field on success: `lib/cve/scanner.ts:132`, `lib/license/scanner.ts:49`, `lib/deps/scanner.ts:50`; callers include the cron loop, `POST /api/scan`, `POST /api/license` at `app/api/license/route.ts:30`, `POST /api/deps` at `app/api/deps/route.ts:48`, and `POST /api/export` for missing scans). It can advance every cron cycle with zero successful scans, as long as the cycle itself is not rate-limited. The consequence is not that a persistently failing repo stops being rescanned: the cron loop's own write means the next cycle sees a fresh `lastScannedAt` and will still attempt the repo again once the interval elapses. The consequence is that a failing scanner becomes invisible to anything that reads `lastScannedAt` as "current": a UI surface like `components/overview/RepoComparisonTable.tsx:43-44` (sorted by this field) and `components/overview/RepoComparisonTable.tsx:165-166` (rendered) or the dashboard's repo detail view can show a fresh "last scanned" time while the underlying deps, license, or CVE data behind it has not actually updated in cycles. `lastScannedAt` answers "was this repo attempted recently," not "are all three scan types current."
