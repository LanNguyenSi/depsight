---
type: invariant
title: "Severity signals: three separate paths, not one gate"
description: a CVE finding reaches a person or a webhook through three separate notification paths (the cve.critical/cve.high webhook events, Slack, and the scan.completed webhook); the first two rank severity through one shared constant and sit behind a hardcoded CRITICAL/HIGH prefilter that runs before the shared SEVERITY_RANK (lib/severity.ts), Slack is additionally gated by SlackConfig.minSeverity, and scan.completed has no severity filter of its own, so a MEDIUM finding reaches scan.completed subscribers as a policy violation when an enabled CVE_MIN_SEVERITY policy at MEDIUM or below exists.
tags: [severity, cve, notifications, policy]
timestamp: 2026-09-29T05:31:08Z
sources:
  - lib/policy/engine.ts
  - lib/alerts/notifier.ts
  - lib/severity.ts
  - lib/alerts/post-scan.ts
  - lib/cve/scanner.ts
  - prisma/schema.prisma
  - mcp/src/tools/cves.ts
  - app/api/slack/route.ts
  - app/settings/SettingsClient.tsx
  - components/AdvisoryList.tsx
---

## One shared ranking for the policy and notification code

`lib/severity.ts` defines the single `SEVERITY_RANK` (`CRITICAL: 4` down to `UNKNOWN: 0`), `severityValue` (an unrecognised severity string ranks like `UNKNOWN`, `0`) and `severityGte` (`:5-22`). Both consumers import it, so the two cannot drift apart: adding a severity tier means editing the one map.

`lib/policy/engine.ts` uses `severityGte` to evaluate a `CVE_MIN_SEVERITY` policy against a scan's advisories (`:188-194`), and its `isSeverity` type guard accepts exactly the keys of `SEVERITY_RANK` (`:20-22`). `lib/alerts/notifier.ts` uses `severityValue` and `SEVERITY_RANK.CRITICAL` inside `notifyForScan` once that function actually runs: pick which of two event names to emit, `'cve.critical'` versus `'cve.high'` (`:159-163`), and gate Slack delivery against the user's configured `SlackConfig.minSeverity` (`:199-204`).

The MCP server carries a separate ranking (`severityRank` in `mcp/src/tools/cves.ts:9-12`, used by `depsight_get_cves`'s `minSeverity` filter); it is its own package, takes no part in policy evaluation or notification and is not covered further here.

## A hardcoded prefilter decides whether `notifyForScan` runs at all

The ranking does not gate whether `notifyForScan` is called in the first place. `lib/cve/scanner.ts:137-138` queries the just-saved advisories with a hardcoded Prisma filter, `severity: { in: ['CRITICAL', 'HIGH'] }`, before `notifyForScan` is ever called (`:140-144`). A scan whose worst finding is `MEDIUM` never reaches `notifyForScan`, so the ranking never runs for it either: the hardcoded set decides eligibility for both the `cve.critical`/`cve.high` event path and the Slack path before the ranking constant is even in scope.

`SlackConfig.minSeverity` (`prisma/schema.prisma:238`, default `HIGH`) is genuinely user-configurable: `POST /api/slack` validates it against `CRITICAL`/`HIGH`/`MEDIUM`/`LOW` (`app/api/slack/route.ts:47-62`) and the settings UI offers all four as a dropdown (`app/settings/SettingsClient.tsx:602-615`). But because `notifyForScan` only ever runs on a scan whose worst advisory is already `CRITICAL` or `HIGH`, setting `minSeverity` to `MEDIUM` or `LOW` has no observable effect on this path: `maxSeverityValue` inside `notifyForScan` is always at least `SEVERITY_RANK.HIGH` whenever the function is reached, so the `MEDIUM`/`LOW` settings behave identically to `HIGH` here.

## A third path bypasses the prefilter: `scan.completed`

`runPostScanHooks` (`lib/cve/scanner.ts:147`, called on every CVE scan that completes, not only ones that pass the CRITICAL/HIGH prefilter; a scan that returns early because one is already running (`:53-55`) or throws (`:158-168`) never reaches it) runs `evaluatePolicies` and then `notifyScanCompleted` (`lib/alerts/post-scan.ts:13-32`, `lib/alerts/notifier.ts:209-239`). `notifyScanCompleted` delivers a `scan.completed` webhook event to every subscriber, carrying the scan's `policyViolations` array, with no severity filter of its own. A `CVE_MIN_SEVERITY` policy configured to flag `MEDIUM` and above therefore does reach `scan.completed` webhook subscribers for a `MEDIUM` finding, through this path, even though the same finding never reaches the `cve.critical`/`cve.high` event path or the Slack path above.

## Consequence: three paths, three different reachability rules

`depsight_evaluate_policy` / `POST /api/policies/evaluate` reports a `CVE_MIN_SEVERITY` violation at whatever threshold the policy is configured to, with no floor of its own beyond the user's setting. Whether that same finding also reaches a human depends on the path. The `cve.critical`/`cve.high` webhook events: the scanner's CRITICAL/HIGH prefilter only. Slack: the same prefilter, then `SlackConfig.enabled` and `SlackConfig.minSeverity` (`lib/alerts/notifier.ts:194-203`), so a `minSeverity` below `HIGH` has no effect. The `scan.completed` webhook: no severity floor of its own; it carries policy violations at whatever threshold the enabled policy was configured for.

This covers only these three notification paths (the `cve.critical`/`cve.high` webhook events, Slack, the `scan.completed` webhook) plus the `CVE_MIN_SEVERITY` evaluation that feeds the third; it does not claim to be every place severity is read. A rendering-only surface like `components/AdvisoryList.tsx`'s severity filter chips is a literal string-array UI filter, not ranking logic, and gates nothing server-side.
