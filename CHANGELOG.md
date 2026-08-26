# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`ApiToken` scope (READ vs. WRITE):** a dsat_ token now carries a
  `scope` (`ApiTokenScope.READ` or `WRITE`), defaulting to `WRITE` so
  every pre-existing token keeps today's full-access behaviour once the
  field is deployed (`prisma db push` backfills the column with its
  default — this repo has no migrations directory, so there is no
  separate migration to check). `resolveRequestUser()` (`lib/auth-api.ts`)
  now returns the resolved scope (a browser session always resolves to
  `WRITE`), and the policy CRUD write operations (`POST /api/policies`,
  `PUT /api/policies/[id]`, `DELETE /api/policies/[id]`) require `WRITE`,
  returning 403 for a `READ`-scoped token; the read operations (`GET`) are
  unaffected. `POST /api/tokens` accepts an optional `scope` in the
  request body (still defaulting to `WRITE` when omitted, so callers that
  don't send it keep minting full-access tokens as before), and the
  Settings token UI lets the user choose the scope when creating a token
  and shows each existing token's scope in its list. This closes the gap
  where a leaked dsat_ token could delete or disable the policies that
  gate CI decisions (`LICENSE_DENY`, `CVE_MIN_SEVERITY`), even when the
  token was only meant to read.
- **`DEPENDENCY_MIN_VERSION` policy type:** expresses a per-package minimum
  version floor (rule shape `{ package: string, minVersion: string }`). The
  evaluator compares each matching dependency's installed version from the
  scan against the floor with semver and reports a violation per package
  below it; installed versions that are not valid semver are skipped and
  counted as unparseable rather than reported as a violation. `minVersion`
  is validated as a real semver version (and `package` as a non-empty
  string, normalized by trimming) when a `DEPENDENCY_MIN_VERSION` policy is
  created via `POST /api/policies`, or updated via `PUT /api/policies/[id]`
  — whether that request sets `type` and `rule` together, sets only `rule`
  on a policy that is already `DEPENDENCY_MIN_VERSION`, or sets only `type`
  to `DEPENDENCY_MIN_VERSION` on a policy whose stored rule then has to
  satisfy the same shape — so a malformed floor, or one left over from a
  policy's previous type, can no longer be saved as an enabled policy that
  silently checks nothing. Trimming the package name on the way in also
  keeps it from silently drifting out of sync with the evaluator's exact
  dependency-name match. The evaluator now also logs a warning when it
  skips unparseable installed versions, even when that skip leaves no
  violation to report.

### Changed

- **cve-sweep skill reduced to the depsight layer (2.0.0):** the skill now
  covers only what applies to every depsight user: MCP discovery
  (`depsight_get_overview`, `depsight_get_cves`), response shapes, and both
  channels' structural blind spots (Dependabot dev-scope auto-dismissal, OSV's
  direct-dependency-only query set) as mechanisms.

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

- **`/api/policies` and `/api/policies/[id]` accept a dsat_ Bearer token**: the policy CRUD routes were still session-only (`auth()`), so headless callers such as the MCP server got 401s. They now resolve the acting user via `resolveRequestUser()`, matching the rest of the API.
- **`PUT /api/policies/[id]` now always persists the validated `DEPENDENCY_MIN_VERSION` rule**: the write-back was previously gated on the request itself sending `rule`, so flipping a policy's `type` to `DEPENDENCY_MIN_VERSION` without resending `rule` (validating the stored rule against the new type) validated the stored rule but never wrote its normalized form back. An unnormalized rule left over from a copy-paste (a padded package name) could survive that flip untouched and never match the evaluator's exact `d.name === targetPackage` lookup, reporting clean forever. The route now writes `result.rule` unconditionally whenever the effective type is `DEPENDENCY_MIN_VERSION`, so every write path for this policy type persists the same validated value.
- **`DEPENDENCY_MIN_VERSION` package names now reject invisible characters and non-lowercase input** instead of silently storing them: zero-width characters (U+200B-U+200D, U+FEFF) survive `trim()` untouched, and npm package names are always lowercase, so a name like `PostCSS` or one carrying a zero-width character previously passed validation, got stored as-is, and never matched a real installed dependency name, reporting clean forever, the same failure class the existing trim was added to close. Both are now rejected with 400 (`package must not contain invisible characters` / `package must be a valid npm package name`) rather than silently accepted.
- **Correction to two measurements cited when `DEPENDENCY_MIN_VERSION` shipped**: `vitest.config.ts` has no per-file coverage floor for `lib/policy/engine.ts`; the second gated file (alongside `app/api/policies/[id]/route.ts`) is `app/api/policies/route.ts`. And the `PolicyList.tsx` semver import change did not remove the client-side semver chunk, it shrank it (measured 26,022 to 9,416 bytes; `semver/valid` still pulls in `parse`/`SemVer`/`re`); `/policies` First Load JS went from 118 kB (`origin/master`) to 127 kB and back down to 122 kB, not to a state where the chunk is gone.

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
