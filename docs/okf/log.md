# Log

<!-- Add new entries at the top, newest first. -->

- 2026-09-29T05:32:18Z, `policy-rule-evaluation.md` rewritten for write-time rule validation
  of all five policy types and the per-row stored-rule warning; line citations
  into `lib/policy/engine.ts` re-pointed in `severity-signals.md` and
  `dependency-age-scanning.md`; `mcp-vs-web-api.md` re-verified against the
  policy routes and `docs/features.md` (no claim changed) and re-stamped.

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
