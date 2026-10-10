# Features

A complete list of what depsight does today, beyond the headline value props in the README.

## Core scans

- **CVE scanning** per repository: severity breakdown, risk scores, vulnerability timeline, risk score history.
- **License detection** and copyleft compliance checking across all supported ecosystems.
- **Per-finding triage.** A finding of the CVE list can be acknowledged or ignored for its repository, with the user and time that set it and an optional note (`AdvisoryState`, `PUT`/`DELETE /api/advisory-state`). The state is keyed by advisory id plus package, so it survives the next scan, and clearing it ("Reopen") makes the finding open again. It is informational: the CVE counts, the risk score, policies, notifications and the MCP `depsight_get_cves` counts still include ignored findings (the MCP advisory list carries the `state` object, so an agent can filter on it). The CVE list can hide ignored findings. One scan holds a given advisory and package once: repeated Dependabot alerts for it (one per manifest in a monorepo) count once. The key is the advisory id plus the package name, not the ecosystem, so the same advisory id on the same package name in two ecosystems collapses into the first row seen.
- **Dependency age tracking** and outdated alerts.
- **Multi-ecosystem support:** npm, Python, Go, Java, Rust, PHP.
- **Per-scanner failure marker.** The CVE, license and dependency-age scanners each keep their own last-success time and last failure message per repository. The repository overview table and the dashboard header show a warning when a scanner is failing, naming the scanner, its error and its last success, so a scanner that keeps failing is no longer hidden behind a fresh "last scanned" time. A scanner that ran but could not read its data source (a revoked GitHub token, a GitHub or OSV outage) is shown with the same marker, and its last-success time does not advance. `lastScannedAt` now means the last time any scanner succeeded (the auto-scan cron no longer sets it after a failed attempt). `GET /api/overview`, and therefore the MCP overview tool, carries an additive `scannerStatus` field per repository.

## Known limitations

- **A degraded run keeps its partial result and its marker.** When a source
  cannot be read (a revoked GitHub token, a GitHub or OSV outage, a rate
  limit) the scanner still stores what it did find and completes its scan
  row, but the run is marked degraded instead of successful: the per-scanner
  failure marker shows, and the scanner's last-success time does not advance.
  The dashboard's in-page "last scanned" time is taken from completed scan
  rows, so it still moves after a degraded scan; read the marker beside it (the marker
  updates after a page reload).
  A repository the token can no longer read (deleted, or access lost) is marked
  degraded too: when the git tree or the root listing answers 404, one repository
  lookup confirms whether the repository itself is gone.
  The scan row carries the reason: `Scan.degradedReason` holds the unreadable
  sources (cut to 500 characters) of a degraded run and is null when every source
  was read. It is exposed as an additive `degradedReason` key by the
  `scan.completed` webhook payload, `POST /api/scan` (still `status: completed`),
  `GET /api/scan` and the MCP `depsight_rescan` answer, so a consumer can tell that
  a completed scan is partial. Which scan counts as the latest is unchanged.
  Two things stay a normal result and are not marked: a source that answered
  "nothing here" (no manifest, no license file, a repository without commits,
  Dependabot alerts not enabled) and a single package whose registry lookup
  failed, which stays an unknown or needs-review row for that package.
- **CVE scanning does not count Dependabot alerts GitHub auto-dismissed.**
  The Dependabot channel (`lib/cve/github-advisories.ts`) fetches only
  `state: 'open'` alerts. GitHub's "Dismiss low impact issues for
  development-scoped dependencies" auto-triage preset is **on by default for
  public repos** and **opt-in for private repos** (no settings-read API
  exists to confirm a specific repo's configuration; this is GitHub's
  documented default, not something verified per repo). An alert it
  dismisses is never `open`, so the Dependabot channel never returns it —
  not marked, not tiered, simply absent from that channel. This is a
  deliberate choice, not a bug to fix by counting `auto_dismissed` the same
  as `open`: GitHub's own classification already distinguishes "low impact
  on a dev-only dependency" from an actually open finding, and blending the
  two would misrepresent what "open" means in the dashboard.
  - Because the preset's default depends on repo **visibility**, not repo
    content, the same advisory can be `open` on a private repo and
    `auto_dismissed` on a public one with the identical dependency — a
    difference in depsight's counts between two repos can reflect that
    default, not a difference in actual exposure.
  - depsight's independent OSV channel queries the UNION of DIRECT manifest
    dependencies (`dependencies` + `devDependencies`) on lockfile-resolved
    versions, dev and prod alike (`lib/manifest-discovery.ts`). It is not a
    backstop for a TRANSITIVE-only package (outside that query set, e.g. a
    dependency pulled in only via another devDependency) — that gap is
    structural, not a bug. For a DIRECT dependency, OSV remains in scope and
    a matching advisory can still reach the merged counts
    (`lib/cve/merge.ts`) even when Dependabot auto-dismissed the same
    finding.
  - Cross-check per repo: `gh api --paginate "repos/<owner>/<repo>/dependabot/alerts?state=auto_dismissed&per_page=100"`.
    An empty result is the common case and does not by itself mean the blind
    spot does not apply to that repo. See the cve-sweep skill
    (`.claude/skills/cve-sweep/SKILL.md`) for the full two-channel discovery
    procedure and each channel's blind spots.
- **A scan that reports 0 advisories does not rule out a vulnerable transitive
  dependency.** The OSV channel queries only direct manifest dependencies (see
  the OSV note above), so a package that a repository installs only
  transitively, for example a runtime helper of a direct dependency or a dev
  dependency of a test tool, can reach depsight through the Dependabot channel
  alone. GitHub raises Dependabot alerts asynchronously, some hours after an
  advisory is published, not at the same moment for every repository, and not
  necessarily for every affected repository; depsight reports only an alert
  that exists and is `open` when the scan runs. Before such an alert exists,
  or when none is raised, a scan shows 0 for a repository whose lockfile
  installs a vulnerable version, and depsight cannot tell that repository from
  a clean one. This is a structural gap, not a scan defect: closing it would need a
  scanner that resolves transitive lockfile entries itself.
  - Mitigation: after triage, run a fleet lockfile scan on the checkouts of the
    tracked repositories. Audit every lockfile, not only the root one
    (`git ls-files '*package-lock.json'`, then
    `npm audit --package-lock-only --audit-level=moderate` in each directory),
    and read a finding depsight does not list as this gap, not as a scan defect.
  - Dependabot cross-check: the `state` parameter of the alerts list takes a
    comma-separated list of `open`, `fixed`, `dismissed` and `auto_dismissed`.
    `state=all` is not a value; the endpoint answers an empty array instead
    of an error, so an empty answer proves nothing. To see whether GitHub ever
    raised an alert for an advisory, list every state:
    `gh api --paginate "repos/<owner>/<repo>/dependabot/alerts?state=open,fixed,dismissed,auto_dismissed&per_page=100"`.

## Reporting and export

- **SBOM export** in CycloneDX 1.4 format.
- **Repository export** (download as zip).
- **Cross-repo comparison** and team health overview.

## Workflow integrations

- **GitHub OAuth** login and repository discovery.
- **PR integration** with automatic CVE comments: the dashboard's PR scan button, or a GitHub `pull_request` webhook (HMAC-verified under a per-repository secret, `opened` and `synchronize`) that scans tracked repositories automatically. Setup is in [docs/configuration.md](configuration.md#pr-scan-webhook-optional).
- **Webhook and Slack notifications.** Webhooks subscribe to `cve.critical`, `cve.high` and `scan.completed`; the two CVE events carry only CRITICAL and HIGH advisories. Slack delivers when a scan's worst advisory reaches the configured minimum severity (CRITICAL, HIGH, MEDIUM or LOW), so a MEDIUM or LOW minimum also posts MEDIUM or LOW findings; the message lists the most severe advisories first and adds a Mittel or Niedrig count field when MEDIUM or LOW rows are listed. The `scan.completed` payload carries `degradedReason` (null unless the scan was degraded, see Known limitations).
- **Dependabot integration:** status check, enable per-repo, bulk-enable across all repos.

## Policy engine

Custom CVE and license rules: define what severity / license combinations are allowed, denied, or require a waiver. See the `/api/policies` endpoint in [docs/api.md](api.md).

Supported policy types are `LICENSE_DENY`, `LICENSE_ALLOW_ONLY`, `CVE_MIN_SEVERITY`, `DEPENDENCY_MAX_AGE` and `DEPENDENCY_MIN_VERSION` (`lib/policy/engine.ts`). Every type is evaluated per scan against the licenses, advisories or dependency ages/versions of that scan.

`DEPENDENCY_MIN_VERSION` expresses a per-package minimum version floor (rule shape `{ package: string, minVersion: string }`, e.g. "package X must resolve to at least version Y"). It compares each matching dependency's installed version from the scan against the floor with semver; installed versions that are not valid semver (a git ref, a `workspace:*` reference, a range) are skipped and counted as unparseable rather than reported as a violation. Because those installations are silently excluded rather than treated as violations, a policy can report clean without having actually checked every installation of the target package (a monorepo where every install uses the workspace protocol is a common case, not an edge case); the evaluator logs a server-side warning when this happens, but the policy result itself does not reflect it. A pre-release of the floor version (e.g. `8.5.18-beta.1` against a floor of `8.5.18`) sorts below the floor under semver ordering and is therefore reported as a violation; this is intended behavior. The `minVersion` must itself be a valid semver version — this is validated when the policy is created or updated, not only at evaluation time.

Every policy type has its rule shape validated when a policy is created or updated (`POST /api/policies`, `PUT /api/policies/[id]`); a rule that does not fit its type is rejected with a 400 and a message naming the field. The shapes are `{ deniedLicenses: string[] }` for `LICENSE_DENY`, `{ allowedLicenses: string[] }` for `LICENSE_ALLOW_ONLY`, `{ minSeverity: Severity }` for `CVE_MIN_SEVERITY` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW` or `UNKNOWN`, uppercase) and `{ maxAgeDays: number }` for `DEPENDENCY_MAX_AGE`. A `PUT` is validated against the resulting type and rule pair, so changing only `type` re-checks the stored rule against the new type. Policies stored before this validation existed are not migrated or rejected: every evaluation logs a server-side `[policy] ... has a malformed rule` warning for each stored row whose rule fails its type's shape check, and evaluation itself is unchanged.

## CI Health

Workflow fail rates, build times, flaky-job detection. depsight syncs the GitHub Actions run data itself, with the owner's stored GitHub token: on the auto-scan cron, after a scan-all, from the CI Health tab, or through `POST /api/ci/sync`. See [CI Health](configuration.md#ci-health-github-actions-sync) for the details.

## MCP server

Queries (CVEs, licenses, deps, policies, CI analytics), SBOM export, and a scan-trigger tool exposed to Claude and other agents via [`mcp/`](../mcp/README.md); read-only apart from the scan trigger.

## Settings

- **API token management:** mint, view-once, and revoke `dsat_` API tokens from the Settings page, choosing a `READ` (read-only) or `WRITE` (read and write, the default) scope at creation time; a `READ` token gets 403 on the policy write routes (`POST`/`PUT`/`DELETE`), on the scan-triggering POSTs and on `POST /api/ci/sync`. Which endpoints accept a token at all is listed in [docs/api.md](api.md).
- **UI language switch:** English / German.

## Operational

- **Health check endpoint:** `GET /api/health` returns service status.
