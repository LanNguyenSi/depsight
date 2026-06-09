# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
