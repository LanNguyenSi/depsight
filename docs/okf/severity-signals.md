---
type: invariant
title: "Severity signals: three separate paths, not one gate"
description: a CVE finding reaches a person or a webhook through three separate notification paths (the cve.critical/cve.high webhook events, Slack, and the scan.completed webhook); the scanner hands every saved advisory to notifyForScan and each channel applies its own threshold with the shared SEVERITY_RANK (lib/severity.ts); the webhook events keep a fixed CRITICAL/HIGH floor, Slack follows SlackConfig.minSeverity (CRITICAL, HIGH, MEDIUM or LOW), and scan.completed has no severity filter of its own, so a MEDIUM finding reaches scan.completed subscribers as a policy violation when an enabled CVE_MIN_SEVERITY policy at MEDIUM or below exists.
tags: [severity, cve, notifications, policy]
timestamp: 2026-09-29T05:49:50Z
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

`lib/policy/engine.ts` uses `severityGte` to evaluate a `CVE_MIN_SEVERITY` policy against a scan's advisories (`:188-194`), and its `isSeverity` type guard accepts exactly the keys of `SEVERITY_RANK` (`:20-22`). `lib/alerts/notifier.ts` uses `severityValue` and `SEVERITY_RANK.CRITICAL` inside `notifyForScan`: keep only `HIGH`-and-above advisories for the webhook events (`:161-163`), pick which of two event names to emit, `'cve.critical'` versus `'cve.high'` (`:165-166`), and gate Slack delivery against the user's configured `SlackConfig.minSeverity` (`:208-221`).

The MCP server carries a separate ranking (`severityRank` in `mcp/src/tools/cves.ts:9-12`, used by `depsight_get_cves`'s `minSeverity` filter); it is its own package, takes no part in policy evaluation or notification and is not covered further here.

## The scanner passes every severity on; each channel filters for itself

`lib/cve/scanner.ts:137-139` loads all of the just-saved advisories for the scan, with no severity filter, and hands them to `notifyForScan` (`:140-144`) whenever the scan has at least one. The thresholds live in `notifyForScan` (`lib/alerts/notifier.ts:149-220`), one per channel.

The webhook events keep a fixed floor. Only advisories ranked `HIGH` or above are kept for them (`:161-163`), the event is `cve.critical` when any of those is `CRITICAL` and `cve.high` otherwise (`:165-166`), and a scan with no `HIGH`-or-above advisory delivers no webhook at all (`:190`). A webhook payload therefore never lists a `MEDIUM` or `LOW` advisory, even in a scan that also has a `CRITICAL` one, and no webhook subscribes to a severity below `HIGH`.

Slack follows `SlackConfig.minSeverity` (`prisma/schema.prisma:238`, default `HIGH`). `POST /api/slack` validates it against `CRITICAL`/`HIGH`/`MEDIUM`/`LOW` (`app/api/slack/route.ts:47-62`) and the settings UI offers the same four as a dropdown (`app/settings/SettingsClient.tsx:602-615`), and each of them takes effect: Slack is delivered when the worst advisory in the scan ranks at or above the setting (`lib/alerts/notifier.ts:209-211`). The message lists the advisories at or above the lower of the setting and `HIGH` (`:215-218`), so a `CRITICAL` or `HIGH` setting lists `CRITICAL` and `HIGH` findings as before and a `MEDIUM` or `LOW` setting also lists the lower severities it asked for. An `UNKNOWN` advisory ranks `0` and never satisfies any of the four settings.

## A third path has no severity floor of its own: `scan.completed`

`runPostScanHooks` (`lib/cve/scanner.ts:147`, called on every CVE scan that completes, whatever severities it found; a scan that returns early because one is already running (`:53-55`) or throws (`:158-168`) never reaches it) runs `evaluatePolicies` and then `notifyScanCompleted` (`lib/alerts/post-scan.ts:13-32`, `lib/alerts/notifier.ts:226-256`). `notifyScanCompleted` delivers a `scan.completed` webhook event to every subscriber, carrying the scan's `policyViolations` array, with no severity filter of its own. A `CVE_MIN_SEVERITY` policy configured to flag `MEDIUM` and above therefore does reach `scan.completed` webhook subscribers for a `MEDIUM` finding, through this path, even though the same finding never reaches the `cve.critical`/`cve.high` event path, and reaches Slack only when `SlackConfig.minSeverity` is `MEDIUM` or `LOW`.

## Consequence: three paths, three different reachability rules

`depsight_evaluate_policy` / `POST /api/policies/evaluate` reports a `CVE_MIN_SEVERITY` violation at whatever threshold the policy is configured to, with no floor of its own beyond the user's setting. Whether that same finding also reaches a human depends on the path. The `cve.critical`/`cve.high` webhook events: a fixed `HIGH` floor inside `notifyForScan`. Slack: `SlackConfig.enabled` and `SlackConfig.minSeverity` (`lib/alerts/notifier.ts:208-221`), any of the four values. The `scan.completed` webhook: no severity floor of its own; it carries policy violations at whatever threshold the enabled policy was configured for.

This covers only these three notification paths (the `cve.critical`/`cve.high` webhook events, Slack, the `scan.completed` webhook) plus the `CVE_MIN_SEVERITY` evaluation that feeds the third; it does not claim to be every place severity is read. A rendering-only surface like `components/AdvisoryList.tsx`'s severity filter chips is a literal string-array UI filter, not ranking logic, and gates nothing server-side.
