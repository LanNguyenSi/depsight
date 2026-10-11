---
type: invariant
title: "Severity signals: three separate paths, not one gate"
description: a CVE finding reaches a person or a webhook through three separate notification paths (the cve.critical/cve.high webhook events, Slack, and the scan.completed webhook); the scanner hands every saved advisory to notifyForScan and each channel applies its own threshold with the shared SEVERITY_RANK (lib/severity.ts); the webhook events keep a fixed CRITICAL/HIGH floor, Slack follows SlackConfig.minSeverity (CRITICAL, HIGH, MEDIUM or LOW), and scan.completed has no severity filter of its own, so a MEDIUM finding reaches scan.completed subscribers as a policy violation when an enabled CVE_MIN_SEVERITY policy at MEDIUM or below exists.
tags: [severity, cve, notifications, policy]
timestamp: 2026-10-10T11:41:26Z
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

`lib/severity.ts` defines the single `SEVERITY_RANK` (`CRITICAL: 4` down to `UNKNOWN: 0`), `severityValue` (an unrecognised severity string ranks like `UNKNOWN`, `0`) and `severityGte` (`lib/severity.ts:5-23#"return severityValue(a) >= severityValue(b);"`). Both consumers import it, so the two cannot drift apart: adding a severity tier means editing the one map.

`lib/policy/engine.ts` uses `severityGte` to evaluate a `CVE_MIN_SEVERITY` policy against a scan's advisories (`lib/policy/engine.ts:248-253#".filter((a) => severityGte(a.severity, minSeverity))"`), and its `isSeverity` type guard accepts exactly the keys of `SEVERITY_RANK` (`lib/policy/engine.ts:20-22#"Object.keys(SEVERITY_RANK).includes(val)"`). `lib/alerts/notifier.ts` uses `severityValue` and `SEVERITY_RANK.CRITICAL` inside `notifyForScan`: keep only `HIGH`-and-above advisories for the webhook events (`lib/alerts/notifier.ts:173-175#"(a) => severityValue(a.severity) >= SEVERITY_RANK.HIGH,"`), pick which of two event names to emit, `'cve.critical'` versus `'cve.high'` (`lib/alerts/notifier.ts:177-178#"webhookMax >= SEVERITY_RANK.CRITICAL ? 'cve.critical' :"`), and gate Slack delivery against the user's configured `SlackConfig.minSeverity` (`lib/alerts/notifier.ts:220-235#"await deliverSlack(slack.webhookUrl, slack.channel,"`).

The MCP server carries a separate ranking (`severityRank` in `mcp/src/tools/cves.ts:9-12#"return idx === -1 ? 99 : idx;"`, used by `depsight_get_cves`'s `minSeverity` filter); it is its own package, takes no part in policy evaluation or notification and is not covered further here.

## The scanner passes every severity on; each channel filters for itself

`lib/cve/scanner.ts:154-156#"where: { scanId: scan.id },"` loads all of the just-saved advisories for the scan, with no severity filter, and hands them to `notifyForScan` (`lib/cve/scanner.ts:157-161#"(err) => console.error('Notification error:', err),"`) whenever the scan has at least one. The thresholds live in `notifyForScan` (`lib/alerts/notifier.ts:161-236#"await deliverSlack(slack.webhookUrl, slack.channel,"`), one per channel.

The webhook events keep a fixed floor. Only advisories ranked `HIGH` or above are kept for them (`lib/alerts/notifier.ts:173-175#"(a) => severityValue(a.severity) >= SEVERITY_RANK.HIGH,"`), the event is `cve.critical` when any of those is `CRITICAL` and `cve.high` otherwise (`lib/alerts/notifier.ts:177-178#"webhookMax >= SEVERITY_RANK.CRITICAL ? 'cve.critical' :"`), and a scan with no `HIGH`-or-above advisory delivers no webhook at all (`lib/alerts/notifier.ts:202-213#".map((wh) => deliverWebhook(wh.url, wh.secret, payload)),"`). A webhook payload therefore never lists a `MEDIUM` or `LOW` advisory, even in a scan that also has a `CRITICAL` one, and no webhook subscribes to a severity below `HIGH`.

Slack follows `SlackConfig.minSeverity` (`prisma/schema.prisma:306#"@default(HIGH)"`, default `HIGH`). `POST /api/slack` validates it against `CRITICAL`/`HIGH`/`MEDIUM`/`LOW` (`app/api/slack/route.ts:47-62#"enabled: enabled ?? true,"`) and the settings UI offers the same four as a dropdown (`app/settings/SettingsClient.tsx:603-616#"</select>"`), and each of them takes effect: Slack is delivered when the worst advisory in the scan ranks at or above the setting (`lib/alerts/notifier.ts:221-223#"if (maxSeverityValue >= slackMin) {"`). The message lists the advisories at or above the lower of the setting and `HIGH` (`lib/alerts/notifier.ts:227-232#".sort((a, b) => severityValue(b.severity) -"`), so a `CRITICAL` or `HIGH` setting lists `CRITICAL` and `HIGH` findings as before and a `MEDIUM` or `LOW` setting also lists the lower severities it asked for. The listed advisories are sorted most severe first before the message is built (`lib/alerts/notifier.ts:230-232#".sort((a, b) => severityValue(b.severity) -"`), so its three-row list never cuts a higher severity in favour of a lower one. The count fields (`buildSlackMessage`, `lib/alerts/notifier.ts:85-134#"toLocaleString('de-DE')"`) are `Kritisch`, `Hoch`, `Mittel` and `Niedrig`, each shown only when at least one advisory of that severity is among the listed rows, and each counts every listed row of that severity, not only the three the message shows. A `CRITICAL` or `HIGH` setting never lists `MEDIUM` or `LOW` rows, so its message carries no `Mittel` or `Niedrig` field and is byte-identical to before. An `UNKNOWN` advisory ranks `0` and never satisfies any of the four settings.

## A third path has no severity floor of its own: `scan.completed`

`runPostScanHooks` (`lib/cve/scanner.ts:164#"runPostScanHooks(userId, repoId, repo.fullName, scan.id,"`, called on every CVE scan that completes, whatever severities it found; a scan that returns early because one is already running (`lib/cve/scanner.ts:58-60#"return { scanId: existingRunning.id, alreadyRunning: true };"`) or throws (`lib/cve/scanner.ts:176-188#"throw error;"`) never reaches it) runs `evaluatePolicies` and then `notifyScanCompleted` (`lib/alerts/post-scan.ts:14-34#"degradedReason,"`, `lib/alerts/notifier.ts:240-272#"subscribers.map((wh) => deliverWebhook(wh.url, wh.secret,"`). `notifyScanCompleted` delivers a `scan.completed` webhook event to every subscriber, carrying the scan's `policyViolations` array, with no severity filter of its own. A `CVE_MIN_SEVERITY` policy configured to flag `MEDIUM` and above therefore does reach `scan.completed` webhook subscribers for a `MEDIUM` finding, through this path, even though the same finding never reaches the `cve.critical`/`cve.high` event path, and reaches Slack only when `SlackConfig.minSeverity` is `MEDIUM` or `LOW`.

## Consequence: three paths, three different reachability rules

`depsight_evaluate_policy` / `POST /api/policies/evaluate` reports a `CVE_MIN_SEVERITY` violation at whatever threshold the policy is configured to, with no floor of its own beyond the user's setting. Whether that same finding also reaches a human depends on the path. The `cve.critical`/`cve.high` webhook events: a fixed `HIGH` floor inside `notifyForScan`. Slack: `SlackConfig.enabled` and `SlackConfig.minSeverity` (`lib/alerts/notifier.ts:220-235#"await deliverSlack(slack.webhookUrl, slack.channel,"`), any of the four values. The `scan.completed` webhook: no severity floor of its own; it carries policy violations at whatever threshold the enabled policy was configured for.

This covers only these three notification paths (the `cve.critical`/`cve.high` webhook events, Slack, the `scan.completed` webhook) plus the `CVE_MIN_SEVERITY` evaluation that feeds the third; it does not claim to be every place severity is read. A rendering-only surface like `components/AdvisoryList.tsx`'s severity filter chips is a literal string-array UI filter, not ranking logic, and gates nothing server-side. The same holds for the per-finding acknowledged / ignored state (`AdvisoryState`, set in that list): it is read only by `GET /api/scan` (`app/api/scan/route.ts`) to annotate each advisory, so the scanner's counts and risk score, the notifier, Slack and the policy engine all work from the advisory rows alone and still include an ignored finding.
