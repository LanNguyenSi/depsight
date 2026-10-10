# Log

<!-- Add new entries at the top, newest first. -->

- 2026-10-10T06:34:00Z, `mcp-vs-web-api.md` and `rescan-and-staleness.md` re-verified after `docs/api.md` and `docs/configuration.md` gained a trust-model paragraph for the inbound GitHub PR-scan webhook and `docs/api.md` a corrected replay-memory size. The sections these docs cite did not change: the MCP server section of `docs/api.md` (read-only apart from the one scan tool) and the `SCAN_INTERVAL_MINUTES` row of `docs/configuration.md`. Checked with `okf-kit check docs/okf`. Re-stamped.
- 2026-10-10T06:12:02Z, `mcp-vs-web-api.md`, `policy-rule-evaluation.md` and `rescan-and-staleness.md` re-verified after `docs/api.md`, `docs/features.md` and `docs/configuration.md` gained the inbound GitHub PR-scan webhook (`POST /api/webhooks/github`): a new environment-variable row and section in the configuration doc, an endpoint row and section in the API doc, and an extended PR integration bullet in the features doc. None of the sections these docs cite changed: the `SCAN_INTERVAL_MINUTES` row of `docs/configuration.md` (the new row sits after it), the Policy engine and MCP server sections of `docs/features.md`, and the MCP server section of `docs/api.md`. The new endpoint resolves no caller (its HMAC is its only authentication) and has no MCP tool, so the claims about `resolveRequestUser` routes and the MCP surface's gaps hold; no cited line in any source file moved. Checked with `okf-kit check docs/okf`. Re-stamped.
- 2026-10-10T05:18:37Z, `severity-signals.md`, `rescan-and-staleness.md`, `dependency-age-scanning.md`, `policy-rule-evaluation.md` and `mcp-vs-web-api.md` re-verified after `prisma/schema.prisma`, `components/AdvisoryList.tsx`, `docs/configuration.md` and `docs/features.md` changed again (the Advisory unique index is now created by the deploy hook's SQL, the redundant `Advisory` scanId index was dropped, the list's state resolution moved to `lib/advisory-state-client.ts`). The schema keeps its line count and the edited lines sit inside the `Advisory` model, which no doc cites, so every cited schema line (`Scan.degradedReason` 86, `ageInDays` 179, `SlackConfig.minSeverity` 297) was re-read at its position and still holds. The `SCAN_INTERVAL_MINUTES` default in `docs/configuration.md` and the Policy engine section of `docs/features.md` are unchanged; the claim about the triage state being read only by `GET /api/scan` still holds, since the moved helpers only resolve the state client side. Checked with `okf-kit check docs/okf`. Re-stamped.

- 2026-10-10T05:05:00Z, `rescan-and-staleness.md`, `severity-signals.md`, `dependency-age-scanning.md`, `mcp-vs-web-api.md` and `policy-rule-evaluation.md` re-verified after the Advisory unique key and the per-finding triage state changed `prisma/schema.prisma`, `app/api/scan/route.ts`, `app/dashboard/DashboardClient.tsx`, `components/AdvisoryList.tsx`, `docs/api.md`, `docs/features.md` and `docs/configuration.md`. The schema gained a line in `User`, a line in `Repo`, the unique key on `Advisory` and the `AdvisoryState` model, so every cited schema line was re-pointed after reading its target (`Repo` 31-76, `Scan` 78-111, the freshness fields 50, 54, 58-60 and 63-65, `Scan.degradedReason` 86, `ageInDays` 179, `SlackConfig.minSeverity` 297). `GET /api/scan` now reads the triage state before its response, so the `degradedReason` key moved to line 115; the POST citations (37, 43) did not move. The dashboard gained an import and a state field, so its three citations moved down by two. `dependency-age-scanning.md` was already stale against `lib/deps/scanner.ts`; its `Dependency.createMany` write at line 43 and the `ageInDays` rewrite at line 50 were read and still hold. The triage state changes no claim about notification, ranking or policy paths: it is read only by `GET /api/scan`, which `severity-signals.md` now says. Checked with `okf-kit check docs/okf` (0.16.0). Re-stamped.

- 2026-10-05T12:54:08Z, `mcp-vs-web-api.md` re-verified after `mcp/src/server.ts` changed for the depsight-mcp 0.6.0 release (only the reported server version string moved from 0.5.0 to 0.6.0, `createServer` still spans `mcp/src/server.ts:15-34`, read after the edit); no claim in the doc names that version, re-stamped.

- 2026-10-05T08:53:23Z, `rescan-and-staleness.md` re-verified after the 429 change also touched `app/dashboard/DashboardClient.tsx` (a scan-all stop message state, an import and the per-step checks), `components/dashboard/CIHealthTab.tsx`, `lib/i18n/translations.ts` and `mcp/src/tools/shared.ts`. Only `DashboardClient.tsx` is a source of this doc and the other three are in no bundle doc's sources; the import, state and loop edits sit above the cited lines and moved them down by two: the `lastScannedAt: detail.scannedAt,` line 352 to 354, the `updateRepo(... lastScannedAt: scannedAt)` line 365 to 367, and the failingScanners block 943-955 to 967-979 (the block grew by the scan-all message paragraph and loop checks above it). Each was re-pointed after reading the head line. `mcp-vs-web-api.md` cites only `mcp/src/client.ts`, re-pointed in the entry below. Re-stamped.
- 2026-10-05T08:46:25Z, `mcp-vs-web-api.md` and `rescan-and-staleness.md` re-verified after `mcp/src/client.ts` gained a 429 branch in `request` (a `RateLimitError` thrown before the generic `HttpError`) and the error class at the end of the file. The branch sits above the tool methods, so every cited `mcp/src/client.ts` line from 59 on moved down by seven (the `depsight_list_repos` through `depsight_rescan` rows in `mcp-vs-web-api.md`, and the `rescan` call in `rescan-and-staleness.md`); each was re-pointed after reading the target line. The lines the docs cite before it (`DepsightClient` and the `fetch()` call) did not move. No claim about how the client fails is made in either doc. Re-stamped.
- 2026-10-05T07:21:08Z, `mcp-vs-web-api.md` re-verified after `GET /api/repos` gained a per-user rate-limit check (`app/api/repos/route.ts`, `lib/rate-limit.ts`) and `docs/api.md` gained a row and note. The route still resolves its caller through `resolveRequestUser`, and the doc's `depsight_list_repos` row cites only `mcp/src/client.ts` lines, which did not change; no cited line moved. Checked with `okf-kit check docs/okf` (0.16.0). Re-stamped.
- 2026-10-04T17:25:40Z, `dependency-age-scanning.md`: the citation of the `POST /api/deps` reader that passes `ageInDays` through moved from `app/api/deps/route.ts:114` to `:122` after the route gained the rate-limit import, comment and check; re-pointed after reading the target line (`ageInDays: d.ageInDays,`). Citation-only change, not re-stamped.
- 2026-10-04T17:11:14Z, `mcp-vs-web-api.md` and `rescan-and-staleness.md` re-verified after `POST /api/license` and `POST /api/deps` gained a per-user rate-limit check (`app/api/license/route.ts`, `app/api/deps/route.ts`) and `docs/api.md` and `docs/configuration.md` changed. The new import, comment lines and limiter check moved the cited lines down: `POST /api/license` 13 to 15 and `POST /api/deps` 25 to 28 (`mcp-vs-web-api.md`), the `scanLicenses` call 30 to 37 and the `scanDependencies` call 48 to 56 (`rescan-and-staleness.md`); each was re-pointed after reading the target line in the changed file. The `docs/api.md` change adds rows and a rate-limit note and the `docs/configuration.md` change adds one sentence pointing at it; no section either doc cites (the MCP server sections, the `SCAN_INTERVAL_MINUTES` row) changed. Checked with `okf-kit check docs/okf` (0.16.0): no STALE or citations-resolve warning left. Re-stamped.
- 2026-10-04T16:48:33Z, `mcp-vs-web-api.md`, `rescan-and-staleness.md` and `severity-signals.md` re-verified after the session-id guard and rate-limit change (`app/api/scan/route.ts`, `app/api/slack/route.ts`, `app/api/export/route.ts`, `app/dashboard/page.tsx` and `docs/api.md` changed). `POST /api/scan` gained an import, a comment and a per-user rate-limit check before the body is read, so the three citations into that route moved down by seven lines (`scanRepository` call 30 to 37, the POST `degradedReason` key 36 to 43, the GET `degradedReason` key 89 to 96) and were re-pointed after reading each target line. The slack, export and dashboard-page edits replace one guard condition in place and move no line, so their citations (`app/api/slack/route.ts:47-62`, `app/api/export/route.ts:33-73`, `app/dashboard/page.tsx:67`) still resolve to the lines they describe. `docs/api.md` gained a Rate limits section and a note on sessions without a user id; the MCP server section both docs cite is unchanged, and `depsight_rescan` still reaches the same scan pipeline (now rate limited per user). Checked with `okf-kit check docs/okf` (0.16.0): no STALE or citations-resolve warning left. Re-stamped.

- 2026-10-04T13:58:35Z, `rescan-and-staleness.md` re-stamped after `docs/configuration.md` gained the 100-runs-per-workflow detail in its CI Health section; the `SCAN_INTERVAL_MINUTES` row this doc cites is unchanged.

- 2026-10-04T13:58:21Z, `mcp-vs-web-api.md` gained the six remaining route files its tool table names as sources (`app/api/repos`, `app/api/repos/tracked-ids`, `app/api/overview`, `app/api/history`, `app/api/ci/analytics/[repoId]`, `app/api/ci/analytics/cross-repo`), so the statement that every listed route resolves its caller through `resolveRequestUser` is watched for staleness. Re-checked with `rg`: each of the six calls `resolveRequestUser` and none calls `auth()`. `docs/api.md` and `docs/configuration.md` changed in wording only (public NextAuth handlers, the 100-runs-per-workflow cap); no cited section moved. Re-stamped.

- 2026-10-04T13:40:21Z, `mcp-vs-web-api.md`, `policy-rule-evaluation.md` and `rescan-and-staleness.md` re-verified after `docs/api.md`, `docs/features.md` and `docs/configuration.md` changed: the api doc now lists which endpoints accept a Bearer token and which are session-only, and the CI Health sections now describe depsight's own GitHub Actions sync instead of an external service. None of the sections these docs cite changed (the Policy engine section of `docs/features.md`, the MCP server sections of `docs/features.md` and `docs/api.md`, and the `SCAN_INTERVAL_MINUTES` row of `docs/configuration.md`), so the last two are re-stamped only. `mcp-vs-web-api.md` gained a statement that every route its tool table names resolves its caller through `resolveRequestUser` (checked with `rg` over those route files: each calls it, none calls `auth()`), after `GET /api/sbom` moved from the session-only check onto it; `app/api/sbom/route.ts` and `lib/auth-api.ts` joined its sources.

- 2026-10-04T12:54:27Z, `mcp-vs-web-api.md` re-verified after `mcp/src/server.ts` changed for the depsight-mcp 0.5.0 release (only the reported server version string moved from 0.4.0 to 0.5.0, `createServer` still spans `mcp/src/server.ts:15-34`); no claim in the doc names that version, re-stamped.

- 2026-10-03T12:12:29Z, okf-staleness workflow re-synced from the okf-kit
  workflow template (fleet convergence ticket fdc01728): the workflow header
  now names the template as its source instead of calling the file a pattern
  to keep in sync, the pin stays okf-kit@0.16.0, `--require-anchors` joined
  the invocation, and the job stays warn-only. Measured on the tree before the
  change with `okf-kit check --json <bundle>`: at okf-kit@0.16.0, 0 errors, 0
  warnings, 0 notices (exit 0) plain and 0 errors, 150 warnings, 0 notices
  (exit 0) with `--require-anchors`; at okf-kit@0.16.0, 0 errors, 0 warnings,
  0 notices (exit 0) plain and 0 errors, 150 warnings, 0 notices (exit 0) with
  `--require-anchors`. Of the anchored-run warnings, 150 are anchor-required
  findings (full citations without an anchor); anchoring them is separate work
  and none of them blocks anything.

- 2026-09-30T04:09:17Z, `mcp-vs-web-api.md` and `policy-rule-evaluation.md` re-verified after the `docs/features.md` Known limitations bullet on transitive-only advisories added that GitHub may not raise an alert for every affected repository: the sections these docs cite did not change, so they are re-stamped only.

- 2026-09-30T04:00:56Z, `mcp-vs-web-api.md` and `policy-rule-evaluation.md` re-verified after `docs/features.md` gained a Known limitations bullet on transitive-only advisories and the Dependabot alert states: the sections these docs cite (the MCP server framing and the Policy engine text) did not change, so they are re-stamped only.

- 2026-09-29T10:46:52Z, `rescan-and-staleness.md` re-verified after the stored degraded reason stopped ending in half of a surrogate pair: the sentence on `scanDegradedReason` now says it cuts to at most 500 characters without splitting a pair, and that the error column stores the same line behind a prefix; no source line moved, so no citation changed.

- 2026-09-29T10:38:03Z, re-verified after the degraded reason was added to the Scan row: `rescan-and-staleness.md` now says each scanner writes the bounded reason on the scan row it completes and that the scan.completed webhook, `POST /api/scan`, `GET /api/scan` and the MCP rescan answer carry it as an additive key, with its citations into the scanners, the notifier, the post-scan hook, the freshness helpers, the scan route, the MCP rescan tool and the schema re-pointed and hand-checked; `severity-signals.md` and `dependency-age-scanning.md` had their citations into the moved lines re-pointed; `mcp-vs-web-api.md` and `policy-rule-evaluation.md` cite sections of `docs/features.md` and `docs/api.md` whose claims still hold, so they are re-stamped only.

- 2026-09-29T10:26:47Z, `rescan-and-staleness.md` re-verified: the repository lookup note now says the 409 tree read of an empty repository does not trigger it by itself, but that repository's root listing answers 404 and runs one lookup per scan, which answers 200 so the scan stays a success; no source line moved, so no citation changed.

- 2026-09-29T10:18:01Z, re-verified after a whole-repository 404 became a degraded source: `rescan-and-staleness.md` now describes the repository lookup that confirms a 404 on the git tree or the root listing, its once-per-scan memoization and the `repository not readable` note, and its citations into `lib/scan/degraded.ts` and `lib/manifest-discovery.ts` were re-pointed and hand-checked; `dependency-age-scanning.md` had one citation into `lib/manifest-discovery.ts` moved by a line; `mcp-vs-web-api.md` and `policy-rule-evaluation.md` cite sections of `docs/features.md` that the added degraded-run sentence did not touch, so they are re-stamped only.

- 2026-09-29T07:51:39Z, `mcp-vs-web-api.md` re-verified after `mcp/src/server.ts` changed for the depsight-mcp 0.4.0 release (only the reported server version string moved from 0.3.0 to 0.4.0); no claim in the doc names that version, re-stamped.

- 2026-09-29T07:26:16Z, re-verified after the Slack Mittel and Niedrig count fields: `severity-signals.md` now says the
  message counts every listed row per severity (`Kritisch`, `Hoch`, `Mittel`, `Niedrig`, each only when
  present) and that a `CRITICAL` or `HIGH` setting stays byte-identical; its citations into
  `lib/alerts/notifier.ts` moved by ten lines and were re-pointed and hand-checked. `mcp-vs-web-api.md`
  and `policy-rule-evaluation.md` cite sections of `docs/features.md` that the one-clause edit to the
  notifications bullet did not touch, so they are re-stamped only.

- 2026-09-29T07:10:46Z, re-verified after the defensive-note tests and the tracking-scope wording change: `rescan-and-staleness.md` now says that readers which never call a noting source are unaffected (PR scanning via `fetchRepoAdvisories`, SBOM, the export bundle reader) and that the export route's on-demand scans are tracked like any other scan, and its `lib/scan/degraded.ts` citations moved with the longer header comment; `mcp-vs-web-api.md` and `policy-rule-evaluation.md` cite sections of `docs/features.md` that the one-clause edit to the degraded-run bullet did not touch, so they are re-stamped only.

- 2026-09-29T06:55:48Z, re-verified after the degraded-source change: `rescan-and-staleness.md` now describes which
  sources report an unreadable read and which answers stay an empty result, replacing its
  known-limitation paragraph, and lists `lib/scan/degraded.ts`, `lib/cve/osv.ts`,
  `lib/manifest-discovery.ts` and `lib/license/detector.ts` as sources; `severity-signals.md`,
  `dependency-age-scanning.md` and `license-classification.md` had their citations into the
  edited scanners, manifest discovery and license detector re-pointed. All four re-stamped; `mcp-vs-web-api.md` and `policy-rule-evaluation.md`
  cite sections of `docs/features.md` that this change did not touch (the MCP read-only framing, the
  Policy engine section), so their claims hold and they are re-stamped only.

- 2026-09-29T06:27:16Z, merged the stale-comment and null-only unknown-age change into the Slack
  minimum-severity branch: `mcp-vs-web-api.md` and `policy-rule-evaluation.md`
  match master's re-pointed route citations; the `lib/policy/engine.ts` and
  `prisma/schema.prisma` edits shift no line cited by `severity-signals.md` or
  `rescan-and-staleness.md`. All four re-verified and re-stamped.

- 2026-09-29T06:19:22Z, merged master (per-scanner freshness) into the Slack minimum-severity branch: `severity-signals.md` keeps the widened notification path, Slack minimum severity and sorted list, with its `lib/cve/scanner.ts` and `prisma/schema.prisma` citations re-pointed against the merged sources; `rescan-and-staleness.md` re-verified against the merged scanner; `policy-rule-evaluation.md` and `mcp-vs-web-api.md` re-verified against the changed `docs/features.md`. All four re-stamped.

- 2026-09-29T06:17:40Z, merged master (per-scanner freshness) into the ageInDays comment branch: the
  null-only unknown age text in `dependency-age-scanning.md` now sits on top of
  the per-scanner freshness text, with its `lib/deps/scanner.ts` and
  `prisma/schema.prisma` citations re-pointed against the merged sources; the
  policies route citations in `policy-rule-evaluation.md` were re-verified;
  `severity-signals.md`, `rescan-and-staleness.md` and `mcp-vs-web-api.md`
  re-verified and re-stamped.

- 2026-09-29T06:10:30Z, `severity-signals.md` now records that the Slack advisory list is sorted most
  severe first (the message keeps the Kritisch and Hoch count fields only);
  every line citation into `lib/alerts/notifier.ts` re-pointed against the
  current file, including the no-webhook-without-HIGH guard.
  `mcp-vs-web-api.md`, `policy-rule-evaluation.md` and `rescan-and-staleness.md`
  re-verified against the changed sources and re-stamped.

- 2026-09-29T06:01:14Z, merged master into the per-scanner freshness branch: citations into
  `lib/cve/scanner.ts`, `lib/deps/scanner.ts` and `prisma/schema.prisma` in
  `severity-signals.md` and `dependency-age-scanning.md` re-pointed against the
  merged sources; `rescan-and-staleness.md` citations re-verified against the
  merged tree; `policy-rule-evaluation.md` and `mcp-vs-web-api.md` re-verified
  against the merged `docs/features.md`. All five re-stamped.

- 2026-09-29T05:59:20Z, `dependency-age-scanning.md` rewritten for the null-only unknown age: the
  schema comment and the `DEPENDENCY_MAX_AGE` check now state `null`, the
  `-1` sentinel stays in the scanners and is converted at the one write path.
  Route citations in `policy-rule-evaluation.md` re-pointed after the policies
  route comments changed; `severity-signals.md`, `rescan-and-staleness.md` and
  `mcp-vs-web-api.md` re-verified (MCP has list and evaluate policy tools only)
  and re-stamped; `index.md` summary updated.

- 2026-09-29T05:52:34Z, merged the shared severity ranking (`lib/severity.ts`) into the policy-validation
  branch: line citations into `lib/policy/engine.ts` re-pointed and verified
  against the merged file in `policy-rule-evaluation.md`, `severity-signals.md`
  and `dependency-age-scanning.md`; `policy-rule-evaluation.md` records the
  padded-package-name gap; `index.md` summary updated; `mcp-vs-web-api.md`
  re-verified against the policy routes and re-stamped.

- 2026-09-29T05:49:50Z, `severity-signals.md` now describes the scanner handing every saved
  advisory to `notifyForScan`, the fixed HIGH floor of the webhook events, and
  Slack's minimum severity taking effect for MEDIUM and LOW; line citations
  into `lib/alerts/notifier.ts` re-pointed. `mcp-vs-web-api.md`,
  `policy-rule-evaluation.md` and `rescan-and-staleness.md` re-verified against
  the changed sources and re-stamped.

- 2026-09-29T05:49:15Z, failure marker limits and doc pointers: `rescan-and-staleness.md` now states
  that the CVE failure marker does not fire for a source outage (a completed
  scan with zero advisories stamps `cveScannedAt`) and re-points its overview
  table citation; `policy-rule-evaluation.md` re-points its `docs/features.md`
  Policy engine range after `docs/features.md` gained a per-scanner failure
  marker entry; `mcp-vs-web-api.md` was re-verified against the changed
  `docs/features.md` and re-stamped.

- 2026-09-29T05:43:22Z, `license-classification.md` and the `index.md` summary line re-verified
  after the Python and Rust scanners took their displayed license and its
  classification from one helper; citations re-pointed and re-stamped.

- 2026-09-29T05:43:06Z, `policy-rule-evaluation.md` states that `createPolicy` and `updatePolicy` are the
  only paths that write a rule and `togglePolicy` flips `enabled` only; line
  citations into `lib/policy/engine.ts` re-pointed in `policy-rule-evaluation.md`,
  `severity-signals.md` and `dependency-age-scanning.md` after a comment edit
  shifted them; `mcp-vs-web-api.md` re-stamped.

- 2026-09-29T05:36:31Z, per-scanner freshness: `rescan-and-staleness.md` now describes the
  per-scanner success and failure columns on `Repo`, that `lastScannedAt` means
  any scanner last succeeded and is no longer written by the cron, the cron's
  own attempt marker and the due-gate that reads both, and the failure marker in
  the overview table and the dashboard. `severity-signals.md` and
  `dependency-age-scanning.md` had their `lib/cve/scanner.ts`,
  `lib/deps/scanner.ts` and `prisma/schema.prisma` citations re-pointed after
  the line shifts; their claims were re-verified and re-stamped, and `index.md`
  carries the updated one-line summary.

- 2026-09-29T05:33:12Z, `license-classification.md` rewritten for the shared classifier in
  `lib/license/classifier.ts`: one copyleft set, one needs-review list, and
  the Java, Python and Rust preparation that runs before it. Re-verified
  against the changed code and re-stamped.

- 2026-09-29T05:32:18Z, `policy-rule-evaluation.md` rewritten for write-time rule validation
  of all five policy types and the per-row stored-rule warning; line citations
  into `lib/policy/engine.ts` re-pointed in `severity-signals.md` and
  `dependency-age-scanning.md`; `mcp-vs-web-api.md` re-verified against the
  policy routes and `docs/features.md` (no claim changed) and re-stamped.

- 2026-09-29T05:31:08Z, `severity-signals.md` now describes the single shared severity
  ranking in `lib/severity.ts` used by the policy engine and the notifier
  instead of two separate constants; line citations into
  `lib/policy/engine.ts` and `lib/alerts/notifier.ts` in
  `severity-signals.md`, `policy-rule-evaluation.md` and
  `dependency-age-scanning.md` were re-pointed. Re-verified and re-stamped.

- 2026-09-27T15:13:26Z, scope wording tightened after the third fact-check pass:
  `severity-signals.md` names the two notification-side rankings, notes the
  MCP `depsight_get_cves` filter's own ranking, and gives each notification
  path its own reachability rule; `rescan-and-staleness.md` states what the
  export loaders treat as a missing scan; `license-classification.md`
  qualifies Rust's dual-license reduction by `PERMISSIVE_RANK` and adds
  npm's repository-level license classification. Re-verified and re-stamped.

- 2026-09-27T15:08:02Z, second fact-check pass: `license-classification.md` now
  describes how Rust (dual-license reduction) and PHP (first array entry)
  prepare the license string before `classifyLicense`;
  `rescan-and-staleness.md` states that export only fills missing scans and
  that any scanner caller, including `POST /api/license` and
  `POST /api/deps`, can advance `lastScannedAt`; `severity-signals.md` and
  `index.md` use one enumeration of the three notification paths and state
  when a MEDIUM finding reaches `scan.completed`; `mcp-vs-web-api.md` lists
  direct license and dependency-age scans among the MCP gaps. The four
  concept docs were re-verified against their sources and re-stamped.

- 2026-09-27T14:58:04Z, fact-check fixes: corrected the notification-posture
  (severity-signals.md, index.md), the four-writer staleness picture
  (rescan-and-staleness.md, index.md), the copyleft-set count and the
  Java/Python normalization contrast (license-classification.md), the
  policy-guard coverage relative to docs/features.md
  (policy-rule-evaluation.md), the missing manifest-discovery.ts source
  (dependency-age-scanning.md), and the MCP rescan scope and tool sources
  (mcp-vs-web-api.md) flagged by independent review against the repo at
  head; re-verified every changed and added file:line pointer.
- 2026-09-27T14:34:51Z, initial bundle: six concept docs (policy rule
  evaluation, severity signals, MCP versus web API, dependency age
  scanning, license classification, rescan and staleness) plus this index
  and log. Every file:line pointer and symbol name verified against the
  repo at commit 453c3ef before writing. Added `.github/workflows/okf-staleness.yml`
  (warn-only, okf-kit pinned to the version agent-dx's canonical workflow
  pins) in the same change.
