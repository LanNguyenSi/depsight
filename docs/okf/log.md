# Log

<!-- Add new entries at the top, newest first. -->

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
