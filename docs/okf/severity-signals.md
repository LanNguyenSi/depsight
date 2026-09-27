---
type: invariant
title: Severity signals - three independent gates, not one ranking
description: CVE_MIN_SEVERITY policy evaluation, Slack/webhook notification event selection, and whether a scan notifies at all are governed by three separate, independently-defined severity checks in two files; only two of the three even rank severity, they use different numeric bases, and the third is a hardcoded CRITICAL/HIGH filter that ignores both rankings and any configured policy threshold.
tags: [severity, cve, notifications, policy]
timestamp: 2026-09-27T14:34:51Z
sources:
  - lib/policy/engine.ts
  - lib/alerts/notifier.ts
  - lib/cve/scanner.ts
  - components/AdvisoryList.tsx
---

## Two rankings, not one shared constant

`lib/policy/engine.ts:15-21` defines `SEVERITY_RANK` (`CRITICAL: 5` down to `UNKNOWN: 1`) and a `severityGte` helper (`:23-25`), used to evaluate a `CVE_MIN_SEVERITY` policy against a scan's advisories (`:200-206`); this is the only severity threshold a depsight user can configure.

`lib/alerts/notifier.ts:148-150` defines its own, separately-declared `SEVERITY_ORDER` (`CRITICAL: 4` down to `UNKNOWN: 0`): same relative ordering, different absolute numbers, a different object entirely. It decides only which of two notification event names to emit for an already-notifying scan, `'cve.critical'` versus `'cve.high'` (`:162-166`), never whether to notify. The two constants are not derived from one another and nothing keeps them in sync; adding a severity tier to one does not add it to the other.

## Whether to notify at all bypasses both rankings

Neither ranking gates whether a Slack/webhook notification fires in the first place. `lib/cve/scanner.ts:136-138` queries the just-saved advisories with a hardcoded Prisma filter, `severity: { in: ['CRITICAL', 'HIGH'] }`, before `notifyForScan` is ever called (`:140-144`). A scan whose worst finding is `MEDIUM` never reaches `notifyForScan`, and `SEVERITY_ORDER` never runs: the hardcoded set decides eligibility before the ranking constant is even in scope.

## Consequence: policy and notification answer different questions

A `CVE_MIN_SEVERITY` policy configured to flag `MEDIUM` and above correctly reports a violation through `depsight_evaluate_policy` / `POST /api/policies/evaluate` for a `MEDIUM` finding; `severityGte` only compares against the user's configured `minSeverity`, with no floor of its own. The same `MEDIUM` finding will never trigger a Slack or webhook notification, because `lib/cve/scanner.ts:136-138`'s `CRITICAL`/`HIGH` filter runs first and unconditionally, regardless of what any policy is configured to. These are two independent signals ("did this violate a configured rule" versus "should this page someone"), and only the first one is severity-threshold-configurable; the second has a fixed floor that no UI or API exposes.

This covers only these three checks (`CVE_MIN_SEVERITY` evaluation, notification event selection, notification eligibility); it does not claim to be every place severity is read. A rendering-only surface like `components/AdvisoryList.tsx`'s severity filter chips is a literal string-array UI filter, not ranking logic, and gates nothing server-side.
