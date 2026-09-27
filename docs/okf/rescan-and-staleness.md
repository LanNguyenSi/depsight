---
type: module
title: Rescan and staleness - one shared timestamp, three independent writers
description: staleness has no dedicated field on Repo or Scan; it is computed fresh each cron cycle from Repo.lastScannedAt, a single field that the CVE, license, and deps scanners each update independently inside their own transaction, so a repo whose deps scan keeps failing while the other two succeed never registers as stale.
tags: [cron, scan, staleness, mcp]
timestamp: 2026-09-27T14:34:51Z
sources:
  - lib/cron/auto-scan.ts
  - lib/cve/scanner.ts
  - lib/license/scanner.ts
  - lib/deps/scanner.ts
  - mcp/src/tools/rescan.ts
  - mcp/src/client.ts
  - prisma/schema.prisma
  - docs/configuration.md
---

## Two trigger paths, one underlying pipeline

A rescan reaches the same CVE scan pipeline two ways: `POST /api/scan`, called directly by the dashboard's rescan action and by the MCP `depsight_rescan` tool (`mcp/src/tools/rescan.ts:10-44` via `mcp/src/client.ts:135-137`), runs `scanRepository()` synchronously for one repo. The auto-scan cron (`lib/cron/auto-scan.ts`) runs on an interval read from `SCAN_INTERVAL_MINUTES` (default 60, documented in `docs/configuration.md`) and, for each stale repo, runs all three scanners (CVE, license, and dependency age) in parallel via `Promise.allSettled` (`lib/cron/auto-scan.ts:90-94`).

## "Stale" is computed, not stored

Neither `Repo` (`prisma/schema.prisma:30-53`) nor `Scan` (`prisma/schema.prisma:55-87`) carries a dedicated staleness flag or expiry timestamp. The cron computes staleness fresh every cycle: `staleThreshold = now - SCAN_INTERVAL_MINUTES`, then selects repos where `lastScannedAt IS NULL OR lastScannedAt < staleThreshold` (`lib/cron/auto-scan.ts:59-68`). `Repo.lastScannedAt` (`prisma/schema.prisma:44`) is the only persisted signal this check has.

## One field, three independent writers

That single field is not written once per rescan attempt; it is written independently by each of the three scanners, inside their own database transaction, whenever that specific scanner completes without throwing: `lib/cve/scanner.ts:130-133`, `lib/license/scanner.ts:47-50`, and `lib/deps/scanner.ts:48-51` each run their own `tx.repo.update({ where: { id: repoId }, data: { lastScannedAt: new Date() } })`. None of the three checks whether the other two also succeeded.

Because the cron loop runs the three scanners with `Promise.allSettled` rather than requiring all three to succeed (`lib/cron/auto-scan.ts:90-94`), a repo whose dependency-age scan persistently fails (an unsupported build tool, a registry outage) while its CVE and license scans keep succeeding will never register as stale to the cron's own gate: `lastScannedAt` keeps advancing off the two scanners that do succeed, every cycle, indefinitely. The cron's own per-scan rejection handling (`lib/cron/auto-scan.ts:96-105`) only logs a warning or flags the whole batch rate-limited; it never affects `lastScannedAt` for the scanners that already committed their own update. `lastScannedAt` answers "did at least one scan type complete for this repo recently," not "are all three scan types current."
