---
type: overview
title: MCP server versus the web API - a thin proxy, narrower than the dashboard
description: every MCP tool calls the same authenticated REST API the dashboard uses, through one HTTP client with no direct database access; only one tool (depsight_rescan) writes, and the MCP surface has no equivalent for policy CRUD, tokens, webhooks, Slack config, Dependabot enable, repo sync, PR-triggered scans, CI sync, export, or direct license and dependency-age scans (depsight_rescan refreshes CVE data only).
tags: [mcp, api, surface]
timestamp: 2026-09-29T05:49:50Z
sources:
  - mcp/src/server.ts
  - mcp/src/client.ts
  - mcp/src/tools/ci.ts
  - mcp/src/tools/cves.ts
  - mcp/src/tools/deps.ts
  - mcp/src/tools/history.ts
  - mcp/src/tools/license.ts
  - mcp/src/tools/policy.ts
  - mcp/src/tools/repos.ts
  - mcp/src/tools/rescan.ts
  - mcp/src/tools/sbom.ts
  - app/api/policies/route.ts
  - app/api/policies/[id]/route.ts
  - app/api/policies/evaluate/route.ts
  - app/api/license/route.ts
  - app/api/deps/route.ts
  - app/api/scan/route.ts
  - docs/api.md
  - docs/features.md
---

## The MCP server has no database access of its own

`createServer` (`mcp/src/server.ts:15-34`) registers 11 tools, one call each to `registerRepoTools`/`registerCveTools`/`registerDepsTools`/`registerLicenseTools`/`registerHistoryTools`/`registerPolicyTools`/`registerCiTools`/`registerSbomTools`/`registerRescanTools`. Every one of them calls a method on `DepsightClient` (`mcp/src/client.ts:18-19`), whose only I/O is `fetch()` against `config.gatewayUrl` with an `Authorization: Bearer <dsat_...>` header (`mcp/src/client.ts:38-47`). No `prisma`/`@prisma` import exists anywhere under `mcp/src` (verified by grep, zero matches outside the tool descriptions' own text). The MCP server cannot diverge from the web API's authorization or business logic; it can only be a narrower client of it, using the same `dsat_` token scoping (`READ`/`WRITE`) the dashboard's own token management already documents.

## Tool-to-endpoint map

| MCP tool | Backing endpoint |
|---|---|
| `depsight_list_repos` | `GET /api/repos` (`mcp/src/client.ts:67`), merged with `GET /api/repos/tracked-ids` (`mcp/src/client.ts:81`) |
| `depsight_get_overview` | `GET /api/overview` (`mcp/src/client.ts:71`) |
| `depsight_get_cves` | `GET /api/scan` (`getScan`, `mcp/src/client.ts:84-86`) |
| `depsight_get_deps` | `GET /api/deps` (`mcp/src/client.ts:88-90`) |
| `depsight_get_license_report` | `GET /api/license` (`mcp/src/client.ts:92-94`) |
| `depsight_get_history` | `GET /api/history` (`mcp/src/client.ts:96-98`) |
| `depsight_list_policies` | `GET /api/policies` (`mcp/src/client.ts:100-102`) |
| `depsight_evaluate_policy` | `POST /api/policies/evaluate` (`mcp/src/client.ts:104-106`) |
| `depsight_ci_analytics` | `GET /api/ci/analytics/[repoId]` or `.../cross-repo` (`mcp/src/client.ts:112-126`) |
| `depsight_get_sbom` | `GET /api/sbom` (`mcp/src/client.ts:108-110`) |
| `depsight_rescan` | `POST /api/scan` (`mcp/src/client.ts:135-137`) |

## Exactly one tool writes; the other POST does not

`depsight_rescan` is the only tool that mutates state: its `POST /api/scan` triggers `scanRepository()`, the CVE scan pipeline (`app/api/scan/route.ts:30`), the same one the dashboard's own rescan action uses. It refreshes CVE data only: neither the license scan (`scanLicenses`) nor the dependency-age scan (`scanDependencies`) runs as part of it, so a call to `depsight_get_deps` or `depsight_get_license_report` right after `depsight_rescan` can still return data from before that call, unchanged. `depsight_evaluate_policy` is also a `POST`, but its own description says "Read-only, does not mutate state" (`mcp/src/tools/policy.ts:26`), and the route it calls, `app/api/policies/evaluate/route.ts`, only calls `evaluatePolicies()` and returns the resulting JSON; no Prisma write call appears anywhere in that route. This confirms the "read-only apart from the scan trigger" framing in the MCP server sections of `docs/features.md` and `docs/api.md` precisely: it means read-only apart from the one tool that scans, not "every POST is a write."

## What the web API can do that MCP cannot

The MCP surface has no tool for: creating, updating, or deleting a policy (`POST`/`PUT`/`DELETE` on `/api/policies` and `/api/policies/[id]`, MCP only lists and evaluates); API token management (`/api/tokens`); webhook configuration (`/api/webhooks`); Slack configuration (`/api/slack`); enabling Dependabot, singly or in bulk (`/api/dependabot`, `/api/dependabot/enable-all`); manually triggering a repo sync (`/api/repos/sync`) or CI sync (`/api/ci/sync`); a PR-triggered scan (`/api/pr-scan`); triggering a license scan directly (`POST /api/license`, `app/api/license/route.ts:13`) or a dependency-age scan directly (`POST /api/deps`, `app/api/deps/route.ts:25`); or a repository export bundle (`/api/export`). An agent restricted to the MCP tools can read an existing policy and evaluate it against a scan, but cannot author or change one; the same gap applies to license and dependency data, where `depsight_rescan`'s CVE-only scope means the MCP surface has no tool that can force either one fresh.
