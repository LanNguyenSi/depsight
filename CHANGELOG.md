# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
