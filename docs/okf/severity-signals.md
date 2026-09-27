---
type: invariant
title: "Severity signals: three separate paths, not one gate"
description: a CVE finding reaches a person or a webhook through three separate paths, each with its own severity check, not one ranking; a MEDIUM/LOW finding is filtered out of the cve.critical/cve.high/Slack path by a hardcoded CRITICAL/HIGH prefilter before either of the file's own severity rankings ever runs, but the same MEDIUM finding still reaches scan.completed webhook subscribers as a policy violation, because that webhook fires on every scan regardless of severity.
tags: [severity, cve, notifications, policy]
timestamp: 2026-09-27T14:58:04Z
sources:
  - lib/policy/engine.ts
  - lib/alerts/notifier.ts
  - lib/alerts/post-scan.ts
  - lib/cve/scanner.ts
  - prisma/schema.prisma
  - app/api/slack/route.ts
  - app/settings/SettingsClient.tsx
  - components/AdvisoryList.tsx
---

## Two rankings, not one shared constant

`lib/policy/engine.ts:15-21` defines `SEVERITY_RANK` (`CRITICAL: 5` down to `UNKNOWN: 1`) and a `severityGte` helper (`:23-25`), used to evaluate a `CVE_MIN_SEVERITY` policy against a scan's advisories (`:200-206`).

`lib/alerts/notifier.ts:148-150` defines its own, separately-declared `SEVERITY_ORDER` (`CRITICAL: 4` down to `UNKNOWN: 0`): same relative ordering, different absolute numbers, a different object entirely. Inside `notifyForScan`, it does two things once that function actually runs: pick which of two event names to emit, `'cve.critical'` versus `'cve.high'` (`:162-166`), and gate Slack delivery against the user's configured `SlackConfig.minSeverity` (`:202-207`). The two constants are not derived from one another and nothing keeps them in sync; adding a severity tier to one does not add it to the other.

## A hardcoded prefilter decides whether `notifyForScan` runs at all

Neither ranking gates whether `notifyForScan` is called in the first place. `lib/cve/scanner.ts:137-138` queries the just-saved advisories with a hardcoded Prisma filter, `severity: { in: ['CRITICAL', 'HIGH'] }`, before `notifyForScan` is ever called (`:140-144`). A scan whose worst finding is `MEDIUM` never reaches `notifyForScan`, so `SEVERITY_ORDER` never runs for it either: the hardcoded set decides eligibility for the webhook-event and Slack path before the ranking constant is even in scope.

`SlackConfig.minSeverity` (`prisma/schema.prisma:238`, default `HIGH`) is genuinely user-configurable: `POST /api/slack` validates it against `CRITICAL`/`HIGH`/`MEDIUM`/`LOW` (`app/api/slack/route.ts:47-62`) and the settings UI offers all four as a dropdown (`app/settings/SettingsClient.tsx:602-615`). But because `notifyForScan` only ever runs on a scan whose worst advisory is already `CRITICAL` or `HIGH`, setting `minSeverity` to `MEDIUM` or `LOW` has no observable effect on this path: `maxSeverityValue` inside `notifyForScan` is always at least `SEVERITY_ORDER.HIGH` whenever the function is reached, so the `MEDIUM`/`LOW` settings behave identically to `HIGH` here.

## A third path bypasses the prefilter: `scan.completed`

`runPostScanHooks` (`lib/cve/scanner.ts:147`, called unconditionally on every CVE scan, not only ones that pass the CRITICAL/HIGH prefilter) runs `evaluatePolicies` and then `notifyScanCompleted` (`lib/alerts/post-scan.ts:13-32`, `lib/alerts/notifier.ts:212-242`). `notifyScanCompleted` delivers a `scan.completed` webhook event to every subscriber, carrying the scan's `policyViolations` array, with no severity filter of its own. A `CVE_MIN_SEVERITY` policy configured to flag `MEDIUM` and above therefore does reach `scan.completed` webhook subscribers for a `MEDIUM` finding, through this path, even though the same finding never reaches the `cve.critical`/`cve.high`/Slack path above.

## Consequence: three paths, three different reachability rules

`depsight_evaluate_policy` / `POST /api/policies/evaluate` reports a `CVE_MIN_SEVERITY` violation at whatever threshold the policy is configured to, with no floor of its own beyond the user's setting. Whether that same finding also reaches a human depends on which path is asked: the `cve.critical`/`cve.high` webhook events and Slack are unreachable below `HIGH` because of the scanner's own prefilter, regardless of `SlackConfig.minSeverity`; the `scan.completed` webhook has no such floor and carries policy violations at whatever severity the policy itself was configured for.

This covers only these three paths (`CVE_MIN_SEVERITY` evaluation, the `cve.critical`/`cve.high`/Slack path, the `scan.completed` webhook); it does not claim to be every place severity is read. A rendering-only surface like `components/AdvisoryList.tsx`'s severity filter chips is a literal string-array UI filter, not ranking logic, and gates nothing server-side.
