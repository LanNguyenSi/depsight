# Features

A complete list of what depsight does today, beyond the headline value props in the README.

## Core scans

- **CVE scanning** per repository: severity breakdown, risk scores, vulnerability timeline, risk score history.
- **License detection** and copyleft compliance checking for npm, Python, Java, Rust and PHP. Go modules are listed with license `UNKNOWN` and flagged for review (see Known limitations).
- **Per-finding triage.** A finding of the CVE list can be acknowledged or ignored for its repository, with the user and time that set it and an optional note (`AdvisoryState`, `PUT`/`DELETE /api/advisory-state`). The state is keyed by advisory id plus package, so it survives the next scan, and clearing it ("Reopen") makes the finding open again. It is informational: the CVE counts, the risk score, policies, notifications and the MCP `depsight_get_cves` counts still include ignored findings (the MCP advisory list carries the `state` object, so an agent can filter on it). The CVE list can hide ignored findings. One scan holds a given advisory and package once: repeated Dependabot alerts for it (one per manifest in a monorepo) count once. The key is the advisory id plus the package name, not the ecosystem, so the same advisory id on the same package name in two ecosystems collapses into the first row seen.
- **Dependency age tracking** and outdated alerts. For npm, the version shown for a package is the manifest floor (the lowest declared spec with its range operator stripped), raised to the lowest of the top-level versions the declaring projects' `package-lock.json` files install for their declarations (a project's own, or for an npm workspace member the root's), only where every declaration is in `dependencies` or `devDependencies`, every declaring project's lockfile proves a higher version and no lockfile installs the floor (the CVE scan's proof); its age and status are computed for the shown version. A declaration in `optionalDependencies`, `peerDependencies` or `bundleDependencies`, yarn-only repositories, lockfileVersion 1, workspaces whose root lockfile does not prove the membership and partially locked repositories keep the floor. A copy installed only as a dependency of another package (nested, or hoisted in a project that does not declare it) is not reflected in the row; a copy of the floor anywhere keeps the floor.
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
- **Go licenses are not detected.** Every Go module is reported as `UNKNOWN`
  and needs review, so the copyleft check never flags a Go dependency,
  `LICENSE_DENY` flags one only when `UNKNOWN` is on its deny list, and
  `LICENSE_ALLOW_ONLY` flags every Go dependency unless `UNKNOWN` is on its
  allow list.
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
    versions, dev and prod alike (`lib/manifest-discovery.ts`). For npm, a
    repository of separate projects that each carry their own
    `package-lock.json` is also queried at the version each manifest's own
    lockfile installs, and so is an npm workspace whose root
    `package-lock.json` proves its members (see below) at the top-level
    version that lockfile installs for a root or member `dependencies` or
    `devDependencies` declaration: a package installed at different versions in different
    projects is queried at each installed version (a project's `dependencies`,
    `devDependencies`, `optionalDependencies` and `peerDependencies` all count,
    since `npm ci` installs them; a peer marked optional in
    `peerDependenciesMeta` counts when the lockfile lists it, a bundled name
    carries no range and never adds a query of its own), and the repository-wide
    entry for it (a manifest floor that no project installs) is removed only
    when everything the scan reads is positively accounted for and no
    `package-lock.json` the scan reads installs it (vendored, build and fixture
    directories are not read); anything that cannot be read or checked keeps the
    entry. That needs a complete git tree; none of the files `yarn.lock`,
    `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`,
    `deno.lock`, `.npmrc`, `pnpm-workspace.yaml`, `.yarnrc.yml` and
    `.pnpmfile.cjs`; no `packageManager` or `devEngines.packageManager` field in
    a manifest the scan reads; every `package.json` the scan reads locked (a
    `package-lock.json` of its own, lockfileVersion 2 or 3, that lists each of its
    dependencies, dev, optional and non-optional peer dependencies in the
    declared range, judged as npm judges a lockfile, and in which every entry of
    an overridden name satisfies a plain string override; a project with a
    stale or missing lockfile, or an override that is not a plain string,
    installs something the lockfile does not show; a workspace member is
    locked by the root's lockfile instead, at the entry it resolves each
    declaration from, its own `<folder>/node_modules/<name>` else the root's
    `node_modules/<name>`, and only without `overrides` of its own); for a
    manifest with a `workspaces` key in or above it, a root lockfile that
    proves the membership: lockfileVersion 2 or 3, its root entry recording the
    `workspaces` value of the root package.json unchanged (the patterns are
    compared, never evaluated), an entry for each member's folder and a
    `node_modules/<member name>` `link: true` entry resolving to exactly that
    folder, every link entry of the lockfile resolving to such a member, every
    dependency spec the scan reads (the four dependency maps and every value
    inside `overrides`, and the spec after the package name in an `overrides`
    key such as `t@file:tools/t`, of every `package.json`, and the same maps of
    every entry of a workspace root's lockfile) a registry range, version,
    dist-tag or `npm:` alias (any other spec, such as `file:`,
    `link:`, `workspace:`, a path in any spelling, git, a URL or a tarball, can
    install a folder as a project of its own with the lockfile shape of a
    member, so one anywhere leaves every workspace root unproven; the specs
    that go through `semver` share one budget of 2,000,000 characters, beyond
    which no root is proven; this does
    not close the case of a folder that is no member: a folder the root lockfile still links after it left the `workspaces` patterns, or after a `file:` spec became a registry range, counts as a member; `npm ci` at the root installs it from the root lockfile, but `npm run` inside that folder installs it on its own without a lockfile), and a
    link that satisfies a declared range only where the member's package.json
    version (equal to its folder entry's) is in that range; in a workspace only
    `dependencies` and `devDependencies` declarations that resolve the root's
    top-level entry are narrow, so an optional, peer, bundled or aliased
    declaration, a copy under a member's own folder (members installing
    different versions) or under a folder between keeps the floor;
    every declaring manifest's lockfile satisfying its declared range; and every
    lockfile entry that names a package carrying a semver version (a git,
    tarball or `file:` version makes the name unknown, and an unknown name is
    kept); no lockfileVersion 1 lockfile anywhere (npm takes each package's
    dependency edges from the registry, not from the lockfile, so it proves
    nothing); and no
    lockfile entry with a `dependencies`, `optionalDependencies` or
    `peerDependencies` edge (a peer the entry marks optional in
    `peerDependenciesMeta` excepted) to a name the same lockfile has no entry
    for, since `npm install` resolves such an edge from the registry (entries
    marked `inBundle` and names the entry lists in `bundleDependencies` are
    exempt; an edge's range is not compared with the held version). The
    removal guarantees no under-reporting for an install that honours the
    lockfiles: `npm ci`, or `npm install` on a lockfile with no missing or
    invalid edge. Outside that guarantee are `npm install` on a lockfile whose
    transitive edges are inconsistent, a git or `file:` dependency changed
    without updating the lockfile, the contents of a bundling optional package
    that the lockfile was written without unpacking (on another platform),
    command line flags, a user or global npmrc, the environment and the state
    of the registry. Also outside it: a lockfile edited by hand so that its
    member entries disagree with its own `workspaces` patterns. A workspace
    member in a vendored, build or fixture directory is not read, so the root
    lockfile's link to it is unproven and the whole workspace keeps every
    repository-wide entry. A workspace manifest the root lockfile does not
    prove (lockfileVersion 1, a missing root lockfile, a `workspaces` value it
    does not record, a member it does not list, a member that is a workspace
    root itself, a dependency spec that is no registry spec anywhere the scan
    reads, a member folder nested deeper than 16 folders or longer than 256
    characters) adds nothing, and one below the root keeps every
    repository-wide entry; repositories with another
    package manager's lockfile and truncated trees keep the
    repository-wide result. The repository-wide query for a name is one
    version, so it is widened for declarations it may not stand for (nothing
    already queried is removed): a `dependencies` or `devDependencies`
    declaration with a plain semver range that the merged lockfile version
    does not satisfy (root `^8.3.0` locked at 8.3.5, `docs/` `^6.0.0` without
    a lockfile) is also queried at its range's lowest version, and a
    declaration with no range to compare (`latest` or another tag, a git or
    `file:` spec, `*`) has every version any lockfile records for the name
    queried, nested copies included (lockfileVersion 2 or 3 and `yarn.lock`;
    a lockfileVersion 1 lockfile is read top-level only). For a name the
    lockfiles resolve ambiguously, or that no lockfile resolves, every version
    any lockfile records for the name is queried (a nested transitive copy in
    one `package-lock.json` is enough to make a name ambiguous, and is queried
    under that name, although another package installs it), and a plain-range
    declaration adds its floor only when no recorded version satisfies its
    range, or when no lockfile records the name (a `yarn.lock` with vite 8.3.5
    and 7.3.7, root `^8.3.0`, `docs/` `^6.0.0` queries vite 6.0.0, 7.3.7 and
    8.3.5; plain range: a spec `semver.validRange` accepts that is not a
    wildcard, floor: the exact version after the operator, else the lowest
    version the range admits). A recorded version counts no matter which
    package or project installs it (there is no per-declarer provenance), so
    a declarer whose range one recorded copy satisfies is not queried at its
    floor even if it installs another version. A project that declares a range the
    resolved version satisfies but installs another version, and a name
    declared only in `optionalDependencies`, `peerDependencies` or
    `bundleDependencies` without a lockfile, are not covered. It is not a
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
- **Repository export** (download as zip; missing scans can be run first, see `POST /api/export` in [docs/api.md](api.md)).
- **Cross-repo comparison** and team health overview.

## Scores

- **Risk score** (per CVE scan): `min(100, round(10 * critical + 5 * high + 2 * medium + 0.5 * low))` over all advisories of the scan, both channels merged, so ten CRITICAL advisories already reach 100. Acknowledged and ignored findings still count (see Per-finding triage above). The overview groups repositories by risk score: 70 and above is high, 40 to 69 medium, below 40 low.
- **Health score** (per repository, overview): 100, minus half the risk score, minus 5 per license issue (at most 20), minus up to 30 for the share of outdated dependencies, minus a CI penalty, clamped to 0 to 100.

## Workflow integrations

- **GitHub OAuth** login and repository discovery.
- **PR integration** with automatic CVE comments: the dashboard's PR scan button, or a GitHub `pull_request` webhook (HMAC-verified under a per-repository secret, `opened` and `synchronize`) that scans tracked repositories automatically. Setup is in [docs/configuration.md](configuration.md#pr-scan-webhook-optional). The comment lists the open Dependabot alerts that were not in the repository's latest completed CVE scan (see [What the PR scan compares](configuration.md#pr-scan-webhook-optional)); it does not analyse the pull request's diff.
- **Webhook and Slack notifications.** Webhooks subscribe to `cve.critical`, `cve.high` and `scan.completed`; the two CVE events carry only CRITICAL and HIGH advisories and repeat on every CVE scan while such advisories stay open. Payloads, headers and the signature are described in [Outgoing webhooks](api.md#outgoing-webhooks). Slack delivers when a scan's worst advisory reaches the configured minimum severity (CRITICAL, HIGH, MEDIUM or LOW), so a MEDIUM or LOW minimum also posts MEDIUM or LOW findings; the message lists the most severe advisories first and adds a Mittel or Niedrig count field when MEDIUM or LOW rows are listed. The `scan.completed` payload carries `degradedReason` (null unless the scan was degraded, see Known limitations).
- **Dependabot integration:** status check, enable per-repo, bulk-enable across all repos.

## Policy engine

Custom CVE, license and dependency rules: a license deny list or allow list, a minimum CVE severity, a maximum dependency age, and a per-package minimum version. Each enabled policy is evaluated against a scan and reports violations. There is no waiver or exception mechanism. See the `/api/policies` and `/api/policies/[id]` endpoints in [docs/api.md](api.md).

Supported policy types are `LICENSE_DENY`, `LICENSE_ALLOW_ONLY`, `CVE_MIN_SEVERITY`, `DEPENDENCY_MAX_AGE` and `DEPENDENCY_MIN_VERSION` (`lib/policy/engine.ts`). Every type is evaluated per scan against the licenses, advisories or dependency ages/versions of that scan.

`DEPENDENCY_MIN_VERSION` expresses a per-package minimum version floor (rule shape `{ package: string, minVersion: string }`, e.g. "package X must resolve to at least version Y"). It compares each matching dependency's installed version from the scan against the floor with semver; installed versions that are not valid semver (a git ref, a `workspace:*` reference, a range) are skipped and counted as unparseable rather than reported as a violation. Because those installations are silently excluded rather than treated as violations, a policy can report clean without having actually checked every installation of the target package (a monorepo where every install uses the workspace protocol is a common case, not an edge case); the evaluator logs a server-side warning when this happens, but the policy result itself does not reflect it. A pre-release of the floor version (e.g. `8.5.18-beta.1` against a floor of `8.5.18`) sorts below the floor under semver ordering and is therefore reported as a violation; this is intended behavior. The `minVersion` must itself be a valid semver version — this is validated when the policy is created or updated, not only at evaluation time. `package` must be a lowercase npm-style package name (optionally scoped, such as `@babel/core`). Names in other formats, such as Maven `group:artifact` coordinates, Go module paths or Composer `vendor/name` packages, are rejected with 400, so this policy type cannot target Java, Go or PHP dependencies.

Every policy type has its rule shape validated when a policy is created or updated (`POST /api/policies`, `PUT /api/policies/[id]`); a rule that does not fit its type is rejected with a 400 and a message naming the field. The shapes are `{ deniedLicenses: string[] }` for `LICENSE_DENY`, `{ allowedLicenses: string[] }` for `LICENSE_ALLOW_ONLY`, `{ minSeverity: Severity }` for `CVE_MIN_SEVERITY` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW` or `UNKNOWN`, uppercase) and `{ maxAgeDays: number }` for `DEPENDENCY_MAX_AGE`. A `PUT` is validated against the resulting type and rule pair, so changing only `type` re-checks the stored rule against the new type. Policies stored before this validation existed are not migrated or rejected: every evaluation logs a server-side `[policy] ... has a malformed rule` warning for each stored row whose rule fails its type's shape check, and evaluation itself is unchanged.

## CI Health

Workflow fail rates, build times, flaky-job detection. depsight syncs the GitHub Actions run data itself, with the owner's stored GitHub token: on the auto-scan cron, after a scan-all, from the CI Health tab, or through `POST /api/ci/sync`. See [CI Health](configuration.md#ci-health-github-actions-sync) for the details.

## MCP server

Queries (CVEs, licenses, deps, policies, CI analytics), SBOM export, and a scan-trigger tool exposed to Claude and other agents via [`mcp/`](../mcp/README.md); read-only apart from the scan trigger.

## Settings

- **API token management:** mint, view-once, and revoke `dsat_` API tokens from the Settings page, choosing a `READ` (read-only, preselected on the page) or `WRITE` (read and write) scope at creation time, while `POST /api/tokens` without a scope creates a `WRITE` token; a `READ` token gets 403 on the policy write routes (`POST`/`PUT`/`DELETE`), on `PUT`/`DELETE /api/advisory-state`, on the scan-triggering POSTs and on `POST /api/ci/sync`. Which endpoints accept a token at all is listed in [docs/api.md](api.md).
- **Outgoing webhooks:** add webhooks for the `cve.critical`, `cve.high` and `scan.completed` events and see whether each is enabled. The page cannot enable, disable or delete a webhook; only `PATCH` and `DELETE /api/webhooks/[id]` from a signed-in session do, see [Outgoing webhooks](api.md#outgoing-webhooks).
- **Slack:** a Slack incoming-webhook URL, an optional channel and the minimum severity that triggers a message, see Workflow integrations above.
- **PR scan webhook secrets:** generate, rotate and remove the per-repository secret, and choose whether fork pull requests are scanned, see [PR scan webhook](configuration.md#pr-scan-webhook-optional).
- **UI language switch:** English / German. The UI starts in German until a language is chosen. PR comments, Slack messages and policy violation messages are always in German.

## Operational

- **Health check endpoint:** `GET /api/health` returns service status.
