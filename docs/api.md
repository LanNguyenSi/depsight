# API reference

All endpoints except `GET /api/health` and the NextAuth sign-in handlers under `/api/auth/*` require authentication. Which credentials an endpoint accepts depends on the route:

- **Session or Bearer token:** `/api/scan`, `/api/license`, `/api/deps`, `/api/history`, `/api/overview`, `/api/sbom`, `/api/repos`, `/api/repos/tracked-ids`, `/api/policies`, `/api/policies/[id]`, `/api/policies/evaluate`, `/api/ci/analytics/*` and `/api/ci/sync` accept either a NextAuth session (the dashboard) or an `Authorization: Bearer dsat_...` API token (headless agents such as the MCP server).
- **Session only:** `/api/export`, `/api/repos/sync`, `/api/dependabot`, `/api/dependabot/check`, `/api/dependabot/enable-all`, `/api/pr-scan`, `/api/me`, `/api/tokens` and `/api/tokens/[id]`, `/api/webhooks` and `/api/webhooks/[id]`, and `/api/slack` reject a Bearer token with 401. Token management is session-only on purpose: a `dsat_` token can never mint, list, or revoke tokens.

A Bearer `dsat_` token carries a `READ` or `WRITE` scope (`POST /api/tokens` accepts an optional `scope` body field, defaulting to `WRITE`); a `READ` token gets 403 on `POST /api/policies`, `PUT`/`DELETE /api/policies/[id]`, `POST /api/ci/sync`, and the three scan-triggering POSTs (`/api/scan`, `/api/license`, `/api/deps`); all other Bearer-capable endpoints work with either scope. A session always has full access.

This table is a curated subset; the app exposes more route handlers (e.g. `/api/me`, `/api/tokens`, `/api/webhooks`, `/api/slack`, `/api/history`, `/api/overview`, `/api/pr-scan`, `/api/ci/analytics/*`) than are listed here.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Trigger CVE scan for a repository (body: `{ repoId }`); the answer carries `degradedReason`, null unless a source could not be read |
| `POST` | `/api/license` | Run license compliance check (body: `{ repoId }`) |
| `GET` | `/api/deps` | Fetch dependency list with age/outdated info |
| `GET` | `/api/sbom` | Export SBOM (CycloneDX 1.4) |
| `POST` | `/api/export` | Export CVE, license and dependency results as a zip archive (body: `{ repoId }`) |
| `GET` | `/api/repos` | List the live GitHub repos for the authenticated user; archived repos are excluded unless `?includeArchived=true` |
| `GET` | `/api/repos/tracked-ids` | Cheap per-tracked-repo id pair, `{ repos: [{ repoId, githubId }] }`; no team-health computation |
| `POST` | `/api/repos/sync` | Sync repositories from GitHub; archived repos are excluded and untracked; response `{ synced, removed, archived }` |
| `GET` | `/api/policies` | List policy rules |
| `POST` | `/api/policies` | Create or update a policy rule (`LICENSE_DENY`, `LICENSE_ALLOW_ONLY`, `CVE_MIN_SEVERITY`, `DEPENDENCY_MAX_AGE`, `DEPENDENCY_MIN_VERSION`); a `rule` that does not fit the type's shape returns 400 |
| `POST` | `/api/dependabot` | Enable Dependabot alerts for a repo (body: `{ repoId }`) |
| `GET` | `/api/dependabot/check` | Check which repos have Dependabot disabled |
| `POST` | `/api/dependabot/enable-all` | Bulk-enable Dependabot for the caller's tracked repos among the given `repoIds` (body: `{ repoIds }`) |
| `POST` | `/api/ci/sync` | Sync GitHub Actions run data into the CI Health analytics (session or `WRITE` Bearer token; optional body `{ repoId }`, omit to sync all tracked repos) |
| `GET` | `/api/health` | Health check (returns service status). Public, no auth required |

## MCP server

For agent access, depsight ships an MCP server in [`mcp/`](../mcp/README.md) that exposes queries (CVEs, licenses, deps, policies, CI analytics), SBOM export, and a scan-trigger tool to Claude and other MCP-capable clients; read-only apart from the scan trigger.
