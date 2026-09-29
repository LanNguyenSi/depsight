# Knowledge bundle index

Curated OKF knowledge bundle for the depsight repo: cross-file semantics,
invariants, and non-obvious mechanisms that no single source file or
existing doc states on its own. The mature references one level up
(`docs/`: architecture.md, api.md, features.md, configuration.md) stay
authoritative for their areas; these docs deliberately do not duplicate
them.

## Invariants

- [Policy rule evaluation](policy-rule-evaluation.md), why every one of the
  five policy types (not only `DEPENDENCY_MIN_VERSION`) silently reports
  zero violations on a malformed rule shape, and why only
  `DEPENDENCY_MIN_VERSION`'s shape is ever validated before it can be
  persisted.
- [Severity signals](severity-signals.md), the three notification paths a
  CVE finding can reach a person or a webhook through (cve.critical/cve.high
  events, Slack, scan.completed), why a MEDIUM finding is unreachable on the
  webhook events, reaches Slack when its minimum severity is MEDIUM or LOW,
  and when it reaches `scan.completed` subscribers as a policy violation (an
  enabled `CVE_MIN_SEVERITY` policy at MEDIUM or below).
- [Dependency age scanning](dependency-age-scanning.md), the shared
  per-ecosystem scanner contract and npm's inline exception, plus why the
  `Dependency.ageInDays` schema comment ("-1 = unknown") no longer
  describes what the column actually stores.
- [License classification](license-classification.md), the five
  independently defined copies of `classifyLicense`/`COPYLEFT_LICENSES`
  (one per ecosystem but Go), and the one way Java's copy has already
  diverged in behavior, not just in location.

## Modules

- [Rescan and staleness](rescan-and-staleness.md), the paths that trigger
  scans (including export, which only fills missing scans), why staleness is computed rather than
  stored, and why one shared timestamp field written by both the three
  individual scanners and the cron loop itself can advance with zero
  successful scans, hiding a persistently failing scanner behind a fresh
  "last scanned" time rather than stopping its rescans.

## Overview

- [MCP server versus the web API](mcp-vs-web-api.md), the 11 MCP tools
  mapped to the REST endpoints they proxy, confirmation that only one tool
  writes, and the web API capabilities (policy CRUD, tokens, webhooks,
  Slack, Dependabot enable, repo sync, PR-triggered scans, CI sync,
  export, direct license and dependency-age scans) that have no MCP
  equivalent.
