# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Publish workflows now install npm with `npm install -g npm@^11.5.1` (the documented trusted-publishing floor) instead of the floating `npm@11`. CI only; no package code change.
- CI: `release.yml` now passes step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. No behavior change for normal tags and versions.

## [0.6.0] - 2026-09-29

**Headline: scanners now say when they cannot read their source, tokens carry a read/write scope, and the policy engine gains a version-floor type.** A scanner that could not read GitHub or OSV no longer reports a clean scan, each scanner carries its own freshness and failure marker, dsat_ tokens can be read-only, `DEPENDENCY_MIN_VERSION` policies enforce a per-package floor, Slack minimum severity MEDIUM/LOW finally delivers, and yarn.lock v1 repos are matched against resolved versions. The deploy needs `prisma db push` (new `ApiToken.scope` column and per-scanner freshness columns). The published MCP package is released as `@opentriologue/depsight-mcp` 0.4.0 (see the list below). depsight is deployed from `master`; this tag is deploy provenance.

**`@opentriologue/depsight-mcp` 0.4.0** (tag `depsight-mcp-v0.4.0`, npm trusted publishing), changes since 0.3.0: `depsight_list_repos` now carries depsight's own `repoId` beside GitHub's numeric `id`, joined on `githubId` through the new tracked-repo ids endpoint `GET /api/repos/tracked-ids`, with a `repoIdMergeUnavailable: true` marker when that lookup did not run (#136, #138); the tool descriptions list `DEPENDENCY_MIN_VERSION` and point callers at the `repoId` field (#124, #136); the `depsight_list_repos` description states that archived repos are excluded and that the returned `id` is GitHub's id (#126, #127); the server now reports version 0.4.0 in the MCP handshake. The mcp lockfile security bumps (#130, #131, #135) only touch the repository's own dev and CI install; npm consumers do not receive them.

### Added

- **`ApiToken` scope (READ vs. WRITE):** a dsat_ token now carries a
  `scope` (`ApiTokenScope.READ` or `WRITE`), defaulting to `WRITE` so
  every pre-existing token keeps today's full-access behaviour once the
  field is deployed (`prisma db push` backfills the column with its
  default, this repo has no migrations directory, so there is no
  separate migration to check). `resolveRequestUser()` (`lib/auth-api.ts`)
  now returns the resolved scope (a browser session always resolves to
  `WRITE`), and the policy CRUD write operations (`POST /api/policies`,
  `PUT /api/policies/[id]`, `DELETE /api/policies/[id]`) require `WRITE`,
  returning 403 for a `READ`-scoped token; the read operations (`GET`) are
  unaffected. The scan-triggering POSTs `/api/scan`, `/api/license`, and
  `/api/deps` require `WRITE` too, since each persists scan results and
  spends the repo owner's GitHub API quota; their `GET` counterparts stay
  open to both scopes. `POST /api/tokens` accepts an optional `scope` in
  the request body (still defaulting to `WRITE` when omitted, so callers
  that don't send it keep minting full-access tokens as before, and
  returning 400 for anything other than `READ`/`WRITE`), and the Settings
  token UI's create-token selector now defaults to `READ` (listed first)
  so a user who doesn't touch it mints a least-privilege token, and shows
  each existing token's scope in its list. `scripts/mint-api-token.ts`
  gained a matching `--scope READ|WRITE` flag (default `WRITE`, for
  compatibility with existing usage). This closes the gap where a leaked
  dsat_ token could delete or disable the policies that gate CI decisions
  (`LICENSE_DENY`, `CVE_MIN_SEVERITY`), or trigger scans that spend the
  owner's GitHub quota, even when the token was only meant to read.
- **`DEPENDENCY_MIN_VERSION` policy type:** expresses a per-package minimum
  version floor (rule shape `{ package: string, minVersion: string }`). The
  evaluator compares each matching dependency's installed version from the
  scan against the floor with semver and reports a violation per package
  below it; installed versions that are not valid semver are skipped and
  counted as unparseable rather than reported as a violation. `minVersion`
  is validated as a real semver version (and `package` as a non-empty
  string, normalized by trimming) when a `DEPENDENCY_MIN_VERSION` policy is
  created via `POST /api/policies`, or updated via `PUT /api/policies/[id]`
  -- whether that request sets `type` and `rule` together, sets only `rule`
  on a policy that is already `DEPENDENCY_MIN_VERSION`, or sets only `type`
  to `DEPENDENCY_MIN_VERSION` on a policy whose stored rule then has to
  satisfy the same shape -- so a malformed floor, or one left over from a
  policy's previous type, can no longer be saved as an enabled policy that
  silently checks nothing. Trimming the package name on the way in also
  keeps it from silently drifting out of sync with the evaluator's exact
  dependency-name match. The evaluator now also logs a warning when it
  skips unparseable installed versions, even when that skip leaves no
  violation to report.
- **Per-scanner freshness and failure markers** (task `d2995827`, #144): the
  cron used to stamp `Repo.lastScannedAt` after every non-rate-limited
  attempt even when all three scanners threw, so a persistently failing
  scanner sat behind an always-fresh "last scanned" time. Each scanner now
  stamps its own success time (`cveScannedAt`, `licenseScannedAt`,
  `depsScannedAt`) and keeps its last failure message (`cveScanError`,
  `licenseScanError`, `depsScanError`), cleared by its next success.
  `lastScannedAt` now means "any scanner last succeeded" and is no longer
  written by the cron; the cron records `lastScanAttemptAt` instead and its
  due-gate skips a repo touched by either, so the scan cadence is unchanged.
  The overview table and the dashboard header show a failure marker per
  failing scanner, and `GET /api/overview` gains an additive
  `scannerStatus` field. Requires `prisma db push` (new nullable columns, no
  backfill, so a scanner shows no success time until it next succeeds).
- **A scanner whose source cannot be read is marked degraded** (task
  `0f3559ba`, #149): the CVE, license and dependency-age scanners used to
  finish "clean" when GitHub or OSV could not be read (revoked token,
  outage), stamping a fresh success time and clearing the failure marker.
  Sources now report an unreadable read (anything but a 404 or an empty
  repository) to a per-scan tracker; the scanner still stores what it found
  but records the run through the per-scanner failure marker above and does
  not advance its last-success time or `lastScannedAt`. A 404 for a missing
  manifest or license file, a disabled Dependabot, and a per-package
  registry miss stay successes.
- **Slack messages show Mittel and Niedrig counts** (task `dfc5302f`,
  #150): when the channel's minimum severity is MEDIUM or LOW, the message
  carries Mittel and Niedrig count fields for the rows it lists.
- **`depsight_rescan` MCP tool** (#83, shipped in `@opentriologue/depsight-mcp`
  0.3.0): `depsight_rescan({ repoId })` posts to `/api/scan` with the
  configured `dsat_` token (it needs a `WRITE`-scoped token, see the
  `ApiToken` scope entry above) and returns `scanId` and `status`, so an
  agent can rescan and then poll `depsight_get_cves`.
- **Advisory source shown** (#97): `GET /api/scan` now serializes
  `Advisory.source` (`dependabot` or `osv`) and the advisory list renders a
  localized source badge per advisory; `depsight_get_cves` passes it through.
- **Lockfile-resolved CVE matching for `yarn.lock` v1** (#110): JS repos
  with a `yarn.lock` are matched against the resolved version instead of the
  manifest floor, like the `package-lock.json` and `uv.lock`/`poetry.lock`
  paths. When `package-lock.json` and `yarn.lock` disagree on a dependency,
  it falls back to the manifest floor rather than trusting either lockfile;
  yarn berry (v2+) lockfiles are detected by their `__metadata` marker and
  skipped, degrading to the manifest floor.
  `pnpm-lock.yaml` is not covered.

### Changed

- **Policy rules are validated for every PolicyType** (task `e3e9795f`):
  `POST /api/policies` and `PUT /api/policies/[id]` now check that `rule`
  fits the policy `type` for all five types and answer 400 with a message on
  mismatch (previously only `DEPENDENCY_MIN_VERSION` was checked). A PUT that
  sends `type` without `rule` now returns 400 when the stored rule does not fit
  the new type. Enabled policies whose stored rule fails the check (rows
  written before this change) log a warning on every evaluation; evaluation
  itself is unchanged and the rows are not migrated.
- **cve-sweep skill reduced to the depsight layer (2.0.0):** the skill now
  covers only what applies to every depsight user: MCP discovery
  (`depsight_get_overview`, `depsight_get_cves`), response shapes, and both
  channels' structural blind spots (Dependabot dev-scope auto-dismissal, OSV's
  direct-dependency-only query set) as mechanisms.
- **Slack minimum severity MEDIUM/LOW takes effect; webhooks unchanged**
  (task `0de0dd3c`, #146): the scanner prefiltered advisories to
  CRITICAL/HIGH before notifying, so a Slack minimum severity of MEDIUM or
  LOW never delivered anything. The prefilter is gone and each channel's
  threshold is applied by `notifyForScan`. Webhooks keep today's behaviour:
  only CRITICAL/HIGH advisories, and no delivery for a scan without one.
  The Slack message now lists advisories most severe first (stable sort) for
  every minimum-severity setting, so the top-3 slice never drops a CRITICAL
  or HIGH row for a lower one; the order and selection of the three listed
  rows in a CRITICAL/HIGH message can therefore differ from 0.5.1.
- **One license classifier for all ecosystems** (task `08b5630e`, #142): the
  copyleft set, the needs-review list and `classifyLicense` moved into
  `lib/license/classifier.ts`. The needs-review list is now `UNKNOWN`, empty,
  `SEE LICENSE IN LICENSE` and `UNLICENSED` everywhere, so Java gains
  `UNLICENSED` and the `SEE LICENSE` fallback, and PHP, Python and Rust gain
  the `SEE LICENSE` fallback. Java full-name matching, PyPI free-text
  normalization and Rust dual-license reduction still run first in their
  ecosystem files.
- **One shared severity ranking** for the policy engine and the notifier
  (task `d884dda4`, #141): refactor, no behaviour change.
- **Lockfile probing follows the tree walk** (#112): the scanner only
  fetches `package-lock.json` and `yarn.lock` paths that the existing tree
  walk observed, so a repo without a `yarn.lock` no longer costs blind 404
  probes; a truncated or failed walk keeps the old blind probing.
- **`@opentriologue/depsight-mcp` requires Node 20 and SDK 1.30**
  (#102, #109): `engines.node` is `>=20` (the locked tree resolves hono 2.x,
  which declares it) and the declared `@modelcontextprotocol/sdk` floor is
  `^1.30.0`, so a consumer whose own lockfile pins an older SDK no longer
  keeps the vulnerable hono.
- **Tests, docs, CI and tooling, no runtime behaviour change:** coverage
  gate and route, lib, CI-analytics and MCP tool tests (#86 to #91, #94),
  pinned `DEPENDENCY_MAX_AGE` boundary (#147) and displayed Python/Rust
  license values (#148); README restructure and `docs/roadmap.md` (#139),
  docs corrections (#116, #117, #118, #122), curated `docs/okf` knowledge
  bundle with a warn-only staleness check (#140), cve-sweep skill hardening
  (#101, #104, #106, #108, #114, #115, #133); `next-env.d.ts` untracked and
  unused test devDependencies dropped (#119), `.next` kept in a named volume
  in the dev container (#95); Node-24-capable Actions majors (#128), npm
  audit regression gate for both lockfile trees (#129), `npm ci --no-audit
  --no-fund` plus an audit gate that tells an endpoint outage from a finding
  (#132), tokenless npm trusted publishing for the MCP package (#120).

### Removed

- Operating-layer content (clone paths, token storage, branch/PR conventions,
  governance/routing, per-machine toolchain pinning, sweep history) from the
  cve-sweep skill: it now belongs in the consuming workspace's own skill
  layer, not in depsight's repo.
- The `verify-toolchain-forms.sh` script from the cve-sweep skill directory;
  toolchain verification is now the consuming workspace's concern.
- The detailed lockfile remediation procedure from the skill body; it now
  points to an external reference at
  https://github.com/LanNguyenSi/agent-dx/blob/master/packages/agentic-coding-playbook/references/npm-lockfile-cve-remediation.md

### Fixed

- **SBOM download filename** (#89): when the SBOM has no component name the
  download was named `sbom-sbom.cdx.json`; it is now `sbom.cdx.json`.
- **`depsight_list_repos` now carries depsight's own `repoId` alongside
  GitHub's numeric `id`** (task `33e80873`): the MCP tool returned only
  GitHub's numeric repo id, while `depsight_rescan` / `depsight_get_cves`
  (and every other `repoId`-taking tool) expect depsight's own id, only
  previously obtainable from `depsight_get_overview`; a caller piping
  the list output straight into `depsight_rescan` got a 404 "Repository
  not found" (reproduced against the live server before the fix).
  `mcp/src/tools/repos.ts` now fetches `/api/overview` alongside
  `/api/repos` and merges each overview entry's `repoId` into the
  matching list entry by `fullName`; GitHub's `id` is left untouched. An
  entry depsight tracks (added by the dashboard's Sync action or the sync
  cron; no scan required) carries `repoId`; an entry without `repoId` is
  not tracked yet and can only be added through depsight's own sync, not
  through `depsight_rescan` (`POST /api/scan` requires an existing
  `repoId`). The overview fetch is capped with a 5s timeout so a slow
  `/api/overview` degrades to "no `repoId` added" through the same path as
  an overview fetch failure, rather than stalling the whole list. Additive
  only: no existing field was renamed, and every other `depsight_*` tool's
  behavior is unchanged.

  `fullName` is a mutable, non-unique join key (depsight's `Repo` model is
  unique on `userId`+`githubId`; `fullName` only refreshes at sync, and the
  overview response carries no `githubId` today to join on instead, so the
  server-side fix is a separate follow-up, out of this task's scope). Round
  2 hardens the client-side join: when two overview entries share the same
  `fullName`, neither attaches a `repoId` to the matching list entry (never
  last-write-wins), and the match is case-sensitive (a case-differing
  `fullName` does not match). The tool description and README row now say
  so, plus the caveat that `repoId` is matched by full name at the time of
  depsight's last sync, so a rename-and-recreate on GitHub can leave it
  stale until the next sync. Round 3 makes the degrade observable: when the
  `/api/overview` leg failed, timed out, or came back in an unrecognised
  shape, the returned list now carries a top-level
  `repoIdMergeUnavailable: true` so a caller can tell "not tracked" apart
  from "the overview leg didn't run this call" instead of confusing the
  two; the key is absent when the merge ran normally. An ambiguous
  `fullName` still yields no `repoId` but is not flagged this way (the
  overview leg itself succeeded); the tool description and README row
  say so and point callers at `depsight_get_overview` to confirm either
  case. Superseded by the `githubId` join of task `ed7ddf84` below,
  before release. A malformed entry in
  `/api/repos`'s own `repos` array (`null` or a non-object) is now also
  returned unchanged instead of throwing inside the merge or being spread
  into character keys.

- **Repo sync now untracks archived GitHub repos:** the GitHub repo sync
  (`lib/repos/sync.ts`, used by `POST /api/repos/sync`) reads GitHub's
  `archived` flag and excludes archived repos from the active sync set,
  so they fall through the same "no longer tracked" path already used
  for repos that disappeared from GitHub: `tracked` flips to `false` on
  the next sync, scan history is never deleted, and once untracked the
  repo is excluded from new scans and policy evaluation (`lib/cve/scanner.ts`
  requires `tracked: true` to start a scan, and `evaluatePolicies()`
  requires `tracked: true` on the scan's repo). A repo whose `archived`
  field is missing or undefined from the GitHub API response is treated
  as not archived and stays tracked, so schema drift never silently
  untracks a repo; an API/network error during sync throws before any DB
  write, so nothing changes either. No new Prisma column: the existing
  `tracked` boolean already drives every scan/policy read, so no
  `prisma db push` is required for this change. `POST /api/repos/sync`
  also reports `archived` (repo count) alongside `synced`/`removed`.
  Archived repos are untracked on the next sync, including the hourly
  auto-scan sync (`instrumentation.ts` / `lib/cron/auto-scan.ts`). Not
  covered by this fix: a truncated GitHub repo LIST response (the
  paginated call stopping early) already, pre-existing, reads as those
  repos "no longer on GitHub" and untracks them via the same removal
  path, independent of the `archived` flag.

- **`GET /api/repos` and `POST /api/dependabot/enable-all` now respect
  the archived/untracked state that the repo sync fix above already
  applies:** `GET /api/repos` (the live GitHub list, also what the
  `depsight_list_repos` MCP tool surfaces) filters out repos where
  GitHub reports `archived: true`; pass `?includeArchived=true` to get
  the unfiltered list back. `POST /api/dependabot/enable-all` now scopes
  its repo lookup to `tracked: true`, so a `repoId` for an archived
  (and thus untracked) repo is silently skipped instead of attempting
  to enable Dependabot on it.

- **`depsight_list_repos`'s `repoId` merge now joins on GitHub's numeric
  id, and no longer pays for a full team-health computation to get it**
  (task `ed7ddf84`): the merge added by the `repoId` fix above (task
  `33e80873`) used `/api/overview` as its only source for depsight's own
  `repoId`, joined by `fullName` -- a mutable, non-unique key that two
  tracked repos can legitimately share, in which case neither got a
  `repoId` (never last-write-wins). A new cheap endpoint, `GET
  /api/repos/tracked-ids` (`lib/repos/tracked-ids.ts`), returns only each
  tracked repo's own `repoId` and GitHub's numeric `githubId` -- no CVE,
  license, dependency, or CI joins, and no call into
  `getTeamHealthOverview` (`lib/overview/team-health.ts`). `depsight_list_repos`
  now calls this endpoint instead of `/api/overview` and joins on
  `githubId`, depsight's `Repo` model's per-user-unique column, so two
  tracked repos sharing one `fullName` now each resolve to their own
  `repoId` instead of neither getting one. The 5s bound on the lookup and
  the `repoIdMergeUnavailable: true` degrade marker (set when the lookup
  fails, times out, or comes back in an unrecognised shape) are
  unchanged; existing response keys of both `/api/repos` and the MCP
  list tool are unchanged. `depsight_get_overview` is untouched and still
  calls `/api/overview` for the full team-health dashboard.

  What the list call now saves, counted from `getTeamHealthOverview`'s
  code path and measured on the live account (three sequential GETs each,
  34 tracked repos, warm server): the `/api/overview` leg the list call no
  longer makes cost 0.79-1.19s, against 0.47-0.71s for the plain `/api/repos`
  leg that runs either way; the new tracked-ids leg is one `repo.findMany` and
  was not measured before deployment. The old merge's `/api/overview` fetch ran that function's full aggregation
  -- 5 aggregate Prisma calls (`repo.findMany`, three `scan.findMany`
  queries for the latest CVE/license/deps scan per repo, and one
  `dependency.groupBy` for outdated counts) plus one `getCIPenalty`
  call per tracked repo (a `repo.findUnique` with a nested
  `workflows -> runs -> jobs` include, run in parallel via
  `Promise.all`) -- on every `depsight_list_repos` call, even though
  the list tool only ever read `repoId` and `fullName` off the result.
  The new endpoint runs exactly one `repo.findMany` regardless of
  tracked-repo count.

- **`/api/policies` and `/api/policies/[id]` accept a dsat_ Bearer token**: the policy CRUD routes were still session-only (`auth()`), so headless callers such as the MCP server got 401s. They now resolve the acting user via `resolveRequestUser()`, matching the rest of the API.
- **`PUT /api/policies/[id]` now always persists the validated `DEPENDENCY_MIN_VERSION` rule**: the write-back was previously gated on the request itself sending `rule`, so flipping a policy's `type` to `DEPENDENCY_MIN_VERSION` without resending `rule` (validating the stored rule against the new type) validated the stored rule but never wrote its normalized form back. An unnormalized rule left over from a copy-paste (a padded package name) could survive that flip untouched and never match the evaluator's exact `d.name === targetPackage` lookup, reporting clean forever. The route now writes `result.rule` unconditionally whenever the effective type is `DEPENDENCY_MIN_VERSION`, so every write path for this policy type persists the same validated value.
- **`DEPENDENCY_MIN_VERSION` package names now reject invisible characters and non-lowercase input** instead of silently storing them: zero-width characters (U+200B-U+200D, U+FEFF) survive `trim()` untouched, and npm package names are always lowercase, so a name like `PostCSS` or one carrying a zero-width character previously passed validation, got stored as-is, and never matched a real installed dependency name, reporting clean forever, the same failure class the existing trim was added to close. Both are now rejected with 400 (`package must not contain invisible characters` / `package must be a valid npm package name`) rather than silently accepted.
- **Correction to two measurements cited when `DEPENDENCY_MIN_VERSION` shipped**: `vitest.config.ts` has no per-file coverage floor for `lib/policy/engine.ts`; the second gated file (alongside `app/api/policies/[id]/route.ts`) is `app/api/policies/route.ts`. And the `PolicyList.tsx` semver import change did not remove the client-side semver chunk, it shrank it (measured 26,022 to 9,416 bytes; `semver/valid` still pulls in `parse`/`SemVer`/`re`); `/policies` First Load JS went from 118 kB (`origin/master`) to 127 kB and back down to 122 kB, not to a state where the chunk is gone.

- **Scan access failures return 403/404, duplicate running scans are
  guarded** (task `5e9a27bc`, #85, #93): `scanRepository` distinguishes
  not-found (404), not-owned (403) and not-tracked (404) instead of a
  generic 500, and returns the in-flight scan when a RUNNING scan exists for
  the repo within `SCAN_RUNNING_WINDOW_MS` (default 5 minutes) rather than
  spawning a duplicate that burns GitHub quota. The export route answers a
  clear 409 `scan_in_progress` in that case, and the `depsight_rescan`
  message says "already in progress".
- **OSV range shown is the one that matched** (#84, #92): the affected range
  shown for a CVE is the interval that contains the queried version, not
  always the first one; interleaved intervals in one range are walked in
  order and `last_affected` is an inclusive upper bound that never surfaces a
  fixed version.
- **Workspace version conflicts resolve to the worst case** (#98): specs are
  compared with `semver.minVersion` instead of a leading-digit regex, so
  x-ranges, hyphen ranges, OR ranges and pre-release tags no longer drop the
  more vulnerable pin; non-comparable specs (`workspace:`, `link:`, `npm:`,
  wildcards) never displace a comparable one.
- **npm lockfile conflicts and aliases** (#111): a bare name resolving to
  more than one distinct version across lockfile entries is dropped and falls
  back to the manifest floor, so a nested lower transitive can no longer
  silence a direct dependency's advisory; `npm:realName@range` aliases are
  queried under the real package name.
- **Unusable manifest floors reach the ambiguous fallback** (#113): a
  non-semver spec that contains a digit (such as a git spec) no longer counts
  as a usable floor and suppresses the fallback; the guard is
  `semver.valid(floor)`, and a range spec (such as `^19`) is also accepted
  through `semver.validRange`, using `semver.minVersion` as the floor.
- **Unknown dependency age is `null`, not `-1`** (task `d5639a62`, #145): the
  scanner already stored `null`, so the engine's `-1` check filtered nothing;
  the check and the schema comment now say `null`, and the policies route
  comments no longer claim the MCP server manages policies.

### Security

- **CVE sweep 2026-09-11** (task `729402b7-12a7-4075-8802-89b41be000c0`):
  closed a manifest-floor false-positive reported by depsight's own OSV
  channel: `postcss` GHSA-fxqj-rqcc-2cmp / CVE-2026-69153 (fixed 8.5.23)
  was flagged even though the root lockfile already resolved `postcss`
  8.5.23, because the OSV channel reads the declared manifest range, not
  the resolved lock version. `postcss`'s `devDependencies` range and the
  top-level `overrides.postcss` floor were both raised from `^8.5.18` to
  `^8.5.23` in `package.json`, then `package-lock.json` was regenerated
  with `npm install --package-lock-only` under npm 10.8.2 (Node 20.20.2,
  nvm); the `edgesOut` crash reported in earlier sweeps did not reproduce
  here, so no npm 11 fallback was needed. The only lockfile change is the
  mirrored `postcss` range string on the root package entry; the resolved
  `node_modules/postcss` version stays 8.5.23 and no nested record was
  added or removed. `mcp/` was not touched: its own lockfile has no direct
  `postcss` entry and its nested copy (`^8.5.26`) was already current;
  `npm audit --audit-level=moderate` stayed clean on both trees before and
  after.

- **CVE sweep 2026-09-09** (task `e8b5849a`): closed five advisories across
  six vulnerable packages (npm audit's count of 6) on the root lockfile by
  regenerating it within existing `package.json` ranges; no dependency
  range change was required for the fix:
  - `next` 15.5.21 -> 15.5.25 (GHSA-p293-qw3h-jr36, critical,
    unauthenticated RCE on windows-hosted servers; GHSA-2xp9-vwfh-vxw4,
    critical, RCE in the Image Optimization API via AVIF files), already
    within the `^15.5.15` range in `package.json`.
  - `sharp` 0.35.3 -> 0.35.4 (GHSA-rgj7-g3m4-5g8c, high, libheif
    vulnerabilities): 0.35.4 was already inside the existing `^0.35.3`
    override (semver `>=0.35.3 <0.36.0-0`), the lockfile was simply stale;
    the override floor was raised to `^0.35.4` deliberately as a regression
    guard, not because the fix needed it. `next` 15.5.25 itself now declares
    `sharp: ^0.34.3 || ^0.35.4`, so the override no longer gates the fixed
    version.
  - `js-yaml` 4.3.1 -> 4.3.2 (GHSA-2883-xcg3-v3hh, high, `maxTotalMergeKeys`
    does not limit CPU use for empty merge sources): a transitive
    dependency of `@eslint/eslintrc`, already within its declared
    `^4.3.0` range, no override needed.
  - `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` 4.1.2 -> 4.1.11
    (GHSA-82fw-gwwq-j7x9, moderate, path traversal / arbitrary file read
    via `@vitest/mocker`'s redirect mock), already within the `^4.1.2`
    devDependency ranges.

  Lockfile regenerated with `npm update next sharp js-yaml vitest
  @vitest/mocker @vitest/coverage-v8 --package-lock-only` under npm
  10.8.2 (Node 20.20.2, nvm); no npm 11 fallback was needed, the
  `edgesOut` crash reported in earlier sweeps for lockfile-only resolves
  with `@vitest/coverage-v8` in the graph did not reproduce here. Side
  effects visible in the lockfile diff (13 entries added, 3 removed, 66
  changed, none across a major), among them: `vite` 8.0.16 -> 8.2.2 and
  `rolldown` 1.0.3 -> 1.2.7 (vitest's internal toolchain), the nested
  `picomatch` under `node_modules/vite` 4.0.4 -> 4.0.7 (the hoisted copy
  unchanged), `vite` now nesting its own `lightningcss` copy instead of
  sharing the hoisted one, `@oxc-project/types` 0.133.0 -> 0.148.0,
  `@emnapi/runtime` 1.10.0 -> 1.11.3 (its nested copy under
  `@img/sharp-wasm32` removed), `@img/sharp-libvips-*` 1.3.2 -> 1.3.3
  across the platform entries, `@rolldown/binding-wasm32-wasi` removed and
  `@rolldown/binding-android-arm-eabi` added.
  `mcp/` was not touched: its own audit gate (moderate-only, `hono` and
  the same `@vitest/mocker` advisory) was already green under
  `--audit-level=high` before this change and stays that way.

- **CVE sweep 2026-09-09, `mcp/` lockfile** (task `105be32b`): closed the
  four remaining moderate Dependabot alerts on `mcp/package-lock.json`
  left open after the root sweep above (the `Audit (mcp)` gate stayed
  green throughout, since it fails only on high/critical):
  - `hono` 4.13.0 -> 4.13.7 (GHSA-crvj-82cr-hjcx, query parser reads
    parameters after the URL fragment; GHSA-g6gw-c38x-mqfc, unbounded
    dot-notation nesting in `parseBody()`; GHSA-gqvv-2mrq-wpjv,
    incomplete fix for CVE-2026-39408, `toSSG()` still writes files
    outside the output directory), a transitive dependency of
    `@modelcontextprotocol/sdk` (`^4.11.4`), already within that range,
    no override needed.
  - `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` 4.1.8 -> 4.1.11
    (GHSA-82fw-gwwq-j7x9, path traversal / arbitrary file read via
    `@vitest/mocker`'s redirect mock): `npm update` alone left these at
    4.1.8 despite the `^4.1.8` devDependency ranges admitting 4.1.11, so
    `vitest` and `@vitest/coverage-v8` were installed explicitly at
    4.1.11, which raised their declared ranges to `^4.1.11`; `@vitest/mocker`
    followed as a nested dependency of `vitest`.

  Lockfile regenerated in two steps under npm 11.19.1 (`npx npm@11`,
  Node 22.23.2 via nvm) after npm 10.8.2's `npm update` hit the known
  `Cannot read properties of null (reading 'edgesOut')` crash on this
  graph: `npm update hono vitest @vitest/mocker @vitest/coverage-v8
  --package-lock-only`, then `npm install vitest@4.1.11
  @vitest/coverage-v8@4.1.11 --package-lock-only`; verified afterwards
  with `npm ci` and `npm audit` under npm 10.8.2 (Node 20.20.2). No
  dependency crossed a major version. Lockfile delta: 1 entry added, 7
  removed, 47 changed, all `vitest`'s and `rolldown`'s own internal
  toolchain and platform binaries (`vite`, `rolldown`,
  `@oxc-project/types`, `lightningcss-*`, `@rolldown/binding-*`) plus
  `hono` itself; the `wasm32`/`emnapi` fallback entries for
  `@rolldown/binding-wasm32-wasi` were dropped and
  `@rolldown/binding-android-arm-eabi` was added by the newer
  `rolldown` release's platform matrix. Root `package.json` and
  `package-lock.json` were not touched.

- **SSRF guard blocks bracketed IPv6 literals synchronously** (#96):
  `new URL('http://[::1]').hostname` keeps its brackets, so `assertPublicUrl`
  skipped the literal-IP branch and only caught these hosts through the
  DNS-failure fallback. Brackets are stripped before the check, and
  `isPrivateIPv6` now also recognizes the compressed-hex form of IPv4-mapped
  addresses (`::ffff:a00:1`) that `URL` produces.
- **Earlier lockfile sweeps, 2026-07 to 2026-09-04** (#99, #100, #102, #103,
  #105, #107, #129, #130, #131): both root CRITICAL advisories closed (`@auth/core`
  and `next-auth`), npm audit findings resolved in root and
  `mcp/` (`postcss`, `next`, `sharp`, `body-parser`, `fast-uri`, `hono`,
  `brace-expansion`, `ip-address`, `undici`, `express-rate-limit`,
  `socket.io-parser`, `qs`, `@humanfs/node`), `js-yaml` 4.3.1 (GHSA-5p4m-2wfm-xmqj),
  `nanoid` 3.3.18 (GHSA-2v37-7h3g-55p8), and the
  `@hono/node-server` advisory GHSA-frvp-7c67-39w9 closed through SDK 1.30.0.

## [0.5.1] - 2026-06-25

**Headline: CVEs are now matched against the resolved lockfile version, not the manifest floor.** A scanner-correctness pass closes the gap between the version a manifest declares as a lower bound and the version actually locked, for both npm and Python projects. depsight is deployed from `master`; this tag is deploy provenance.

### Fixed

- **CVEs matched against the resolved lockfile version, not the manifest floor** (PR #79): npm/Node advisories are now evaluated against the version actually resolved in the lockfile rather than the lower bound declared in the manifest, removing false positives and negatives caused by the floor-vs-resolved gap.
- **Python CVEs resolved against `uv.lock`/`poetry.lock`, not the `pyproject` floor** (PR #80): the same resolved-version correctness for Python, reading the locked version from `uv.lock` or `poetry.lock` instead of the `pyproject.toml` floor.

### Docs

- **Dashboard hero screenshot added to the README** (PR #81).

## [0.5.0] - 2026-06-20

**Headline: OSV.dev added as a second CVE source, plus a UI hardening pass and the notification/policy pipeline wired end to end.** depsight is deployed from `master`; this tag is deploy provenance.

### Added

- **OSV.dev as a second CVE source** (PR #76): dependencies are now matched against OSV.dev in addition to GitHub Dependabot, so CVEs that Dependabot misses (it must be enabled per-repo, is capped, and covers Go/PyPI weakly) are caught. Cross-source dedup keys on (advisory id, package) and collapses OSV alias twins to the canonical record. Adds `Advisory.source` and `Scan.ecosystem`; CycloneDX SBOM PURLs are now ecosystem-aware, and a repo with a clean scan (no advisories) can export an SBOM.
- **Notification settings UI** (PR #73): Slack and outbound-webhook configuration now have a UI under Settings (previously reachable only via the API).
- **Content-list filters and dashboard deep links** (PR #73): severity/status filter chips plus text search on the advisory, dependency, and license lists; the dashboard's selected repo and active tab are reflected in the URL for deep links and Back/Forward.
- **scan.completed event and automatic post-scan policy evaluation** (PR #75): the scan.completed webhook event now fires for every scan, policy evaluation runs automatically after each scan, the license and dependency scanners now emit notifications, and the background cron syncs CI every cycle.
- **MCP v0.3.0** (PR #77): new read-only `depsight_list_policies` and `depsight_get_sbom` tools; the ci-analytics period input is now a numeric literal union.

### Fixed

- **Scanner correctness** (PR #74): Dependabot alerts now paginate (were capped at the first 100) with rate-limit-aware 403 handling, so a transient 403 no longer hides every advisory; Maven dependency age is computed from the installed version (`core=gav`) instead of the latest release; Go latest-version selection no longer assumes the proxy list is sorted; the cross-repo CI summary reports the real flaky-job count.
- **Cross-workspace dependency conflict** (PR #70): keep the lowest concrete version when two workspaces pin the same dependency to different specs.
- **i18n leaks** (PR #73): the CI Health tab and several dashboard strings were hardcoded; they are now localized, and timeline dates follow the active locale.

### Security

- **CVE sweep** (PR #69): vite and js-yaml advisories cleared.
- **hono bumped in `mcp/`** (PR #72) for the CORS advisory.

### Docs

- **README and docs drift fixes** (PR #71).

## [0.4.1] - 2026-06-16

**Headline: Security patch for esbuild CVE GHSA-g7r4-m6w7-qqqr across the app and the MCP sub-package.**

### Security

- **esbuild pinned to >=0.28.1 in the root manifest** (PR #66): added an `overrides` entry to constrain the optional peer dep range that vite brings in (`^0.27.0 || ^0.28.0`) to `>=0.28.1` (GHSA-g7r4-m6w7-qqqr).
- **esbuild pinned to >=0.28.1 in `mcp/`** (PR #67): the `mcp/` sub-package lockfile still resolved esbuild 0.27.7 via `tsx` and `vite`; bumped `tsx` to `^4.22.4` and added an `esbuild ^0.28.1` override (GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr).

## [0.4.0] - 2026-06-09

**Headline: monorepo and inherited-version support for the non-npm scanners (Java, Rust, and friends).** depsight now walks the full git tree for manifests and resolves versions inherited from a parent POM or a Cargo workspace, so a polyglot monorepo gets its deps and licenses resolved across every ecosystem instead of just the root. depsight is deployed from `master`; this tag is deploy provenance.

### Added

- **Full git-tree manifest discovery for monorepos** (PRs #59, #62). The scanners walk the entire git tree for manifests and union all manifest paths for the non-npm ecosystems, so deps and licenses resolve across a monorepo's sub-projects rather than only the repository root.
- **Java: versions resolved from the parent POM `<dependencyManagement>`** (PR #64), so a child module that omits an explicit version inherits it correctly.
- **Rust: `[workspace.dependencies]` inheritance resolved in `Cargo.toml` scanning** (PR #63), so workspace-inherited crate versions are recognised.

### Changed

- **Removed stale planforge / scaffoldkit bootstrap artifacts** (PR #58).

> The hono (#61) and vitest (#60) CVE bumps in this window were scoped to the `mcp/` package (`@opentriologue/depsight-mcp`), not the deployed app: hono is not an app dependency, and the app's vitest was already current. They are intentionally absent here. The `depsight-mcp` package is not re-released because consumers resolve hono via its `^4` range and vitest is a devDependency.

## [0.3.0] - 2026-05-31

**Headline: self-service API tokens and a hardened, agent-driven CVE
sweep.** You can now mint and revoke `dsat_` service tokens from the
Settings page instead of running a CLI, switch the UI language, and
drive an org-wide CVE sweep from a committed `/cve-sweep` skill that
sources discovery and triage straight from depsight's MCP. This release
also closes a HIGH audit finding (repo-ownership scoping plus an SSRF
guard) and clears a batch of dependency CVEs.

### Added

- **Settings page + user menu** (#55): manage `dsat_` API tokens from
  the UI (mint, view-once, revoke), backed by the existing `ApiToken`
  model, and relocates the UI language switch (English/German) into
  Settings.
- **`/cve-sweep` skill** (#56): a committed, model-invoked Claude Code
  skill at `.claude/skills/cve-sweep/` that runs the org CVE sweep off
  the depsight MCP (`depsight_get_overview` for discovery,
  `depsight_get_cves` for triage), then lockfile-first remediation one
  branch per repo with the governance routing.
- **Tag-driven npm publish for the MCP** (#54): pushing a
  `depsight-mcp-v*` tag publishes `@opentriologue/depsight-mcp` with
  provenance via `.github/workflows/publish-npm.yml`.
- **Open-source surface** (#45): LICENSE, Code of Conduct, contributing
  guide, security policy, and issue/PR templates.

### Changed

- **ESLint flat config** (#50): migrated off the deprecated `next lint`
  to a flat `eslint.config.mjs`.
- **Docs** (#44, #51): README 60-second hook and a restructure into
  `docs/`, plus an env-var reference table in `configuration.md`.
- **Config cleanup** (#52): dropped the unused `JWT_SECRET` config and
  the `jsonwebtoken` dependency.
- **Repo hygiene** (#48): gitignore `*.tsbuildinfo` and stop tracking
  `tsconfig.tsbuildinfo`.

### Security

- **Repo-ownership scoping + SSRF guard** (#53, HIGH audit): CI
  analytics endpoints now enforce repo ownership for the requesting
  user, and webhook/Slack URL inputs are validated against an SSRF
  guard before any outbound request.
- **Dependency CVE sweep** (#46): bumped `fast-uri`, `hono`,
  `ip-address`, and `express-rate-limit`.
- **postcss** (#47): pinned `>= 8.5.10` via override (GHSA-qx2v-qp2m-jg93).
- **qs** (#49): bumped to 6.15.2 in `mcp/` (CVE-2026-8723).

## [0.2.0] - 2026-04-17

**Headline: Agents can now talk to depsight.** New `depsight-mcp`
subpackage exposes the read API over MCP, with a service-token
(`dsat_`) auth path that sits alongside the existing NextAuth session
flow — so Claude and other agents can query overview / CVEs / license
/ CI analytics without scraping the UI or impersonating a user.

### Added

- **`@opentriologue/depsight-mcp` server** (`mcp/`) — stdio MCP
  server, npx-installable, zod + MCP SDK, vitest-covered. Mirrors the
  `ops-mcp` layout. Read-only tools: `depsight_list_repos`,
  `depsight_get_overview`, `depsight_get_cves` (filters by
  `minSeverity` + `publishedAfter`), `depsight_get_license_report`,
  `depsight_get_deps`, `depsight_get_history`,
  `depsight_evaluate_policy` (pure, no state mutation),
  `depsight_ci_analytics` (per-repo + cross-repo).
- **Service-token auth path** — new `lib/auth-api.ts`
  `resolveRequestUser()` helper. Tries NextAuth session first, then
  `Authorization: Bearer dsat_<token>` against the existing
  `ApiToken` Prisma model. Fails closed on non-`dsat_` prefixes,
  respects `revokedAt`, and stamps `lastUsedAt` fire-and-forget.
- **`scripts/mint-api-token.ts`** — CLI that mints a `dsat_` token
  for a given `userId`, prints the raw token once, and stores only
  the row. Redacts Prisma error details on failure.
- **MCP docs** (`mcp/README.md`) — Claude Desktop config, smoke
  test (real `tools/call` round-trip), token-minting procedure,
  v1 scope notes.

### Changed

- 8 MCP-consumed routes refactored to use `resolveRequestUser()`
  while preserving semantics for existing session callers:
  `/api/overview`, `/api/repos`, `/api/scan`, `/api/deps`,
  `/api/license`, `/api/history`, `/api/policies/evaluate`,
  `/api/ci/analytics` (both variants).

### Fixed

- **GitHub repo filter** — `getUserRepos` no longer pulls in
  repos the user is merely a collaborator on. Affiliation is now
  restricted to `owner` + `organization_member`, so dashboard
  counts and scans reflect repos the user actually owns.
- **Root tsconfig excludes `mcp/` + `scripts/`** — the MCP
  subpackage owns its own tsconfig and deps; `scripts/` runs via
  `tsx`. The root Next.js `tsc --noEmit` was pulling their files
  into the main type-check without their types, breaking CI.

## [0.1.0] - 2026-04-15

**Headline: First tagged release of depsight — a GitHub-connected
developer security dashboard for CVE tracking, license compliance,
dependency health, and CI insights across all your repos.**

This is the baseline release. Everything below describes what the
dashboard ships with today.

### Added

#### Core dashboard

- **`/overview` as post-login landing page** — unified dashboard view
  with a Sync button that triggers a fresh scan across all connected
  repos.
- **Dependency / CVE surface** — GitHub-connected inventory of
  dependencies and known vulnerabilities, with license compliance
  tracking (`spdx-license-list`, `spdx-satisfies`).
- **Cron-based auto-scan** — background scanner with a configurable
  interval so the dashboard stays fresh without manual pokes.
- **Scan-all** — kicks off a CI Insights sync fire-and-forget per
  repo alongside the dependency scan.

#### CI Insights integration

- **CI Health tab** — per-repo view of CI signals and historical
  failure patterns, integrated into the depsight surface.
- **Tab gating** — CI Health tab is hidden until CI data has been
  ingested for the repo; once data exists, an empty-state hint
  guides the user on how to start the first sync.
- **README docs** — CI Health section cross-links the upstream
  `ci-insights` project.

#### Ops & deployment

- **Traefik + agent-relay deployment** — `.relay.yml` descriptor
  consumed by `agent-relay`, `docker-compose.traefik.yml` as the
  deploy compose file, `compose exec` used by relay post-update
  hooks. Ephemeral Prisma-migration container with `openssl`
  installed, `HOME=/tmp`, using `traefik-public` network.
- **Health endpoint** — `/api/health` for liveness checks.
- **Dockerized dev commands** — quality-of-life scripts for local
  iteration.
- **Prettier config** committed for consistent formatting.

#### Tests & quality gates

- **Vitest** test suite with `happy-dom` + `@testing-library/react`
  + `@vitest/coverage-v8`.
- **CI test step** added alongside lint, typecheck, and build.

### Security

- Bump `next` to 15.5.15 to address **GHSA-q4gf-8mx6-v5v3** (high-severity
  Denial of Service via Server Components, affects `>=13.0.0 <15.5.15`).
  The App Router pages in this dashboard render via RSC, so the
  vulnerable code path was reachable. Same-minor patch, no functional
  changes expected.
- `vite` high-severity CVEs patched.
- `defu` prototype-pollution CVE — upgraded to 6.1.6.
- `brace-expansion` CVE patched.

### Release infrastructure

- This release introduces `.github/workflows/release.yml`, triggered
  on `v*` tags. It reuses the existing `ci.yml` via `workflow_call`,
  extracts this CHANGELOG section for the tagged version, and
  publishes the GitHub Release via `softprops/action-gh-release@v2`.
- `package.json` version remains at `0.1.0`.
