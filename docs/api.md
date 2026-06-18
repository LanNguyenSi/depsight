# API reference

All endpoints except `GET /api/health` require authentication via NextAuth session or Bearer token.

This table is a curated subset; the app exposes more route handlers (e.g. `/api/me`, `/api/repos`, `/api/tokens`, `/api/webhooks`, `/api/slack`, `/api/history`, `/api/overview`, `/api/pr-scan`, `/api/ci/analytics/*`) than are listed here.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Trigger CVE scan for a repository (body: `{ repoId }`) |
| `POST` | `/api/license` | Run license compliance check (body: `{ repoId }`) |
| `GET` | `/api/deps` | Fetch dependency list with age/outdated info |
| `GET` | `/api/sbom` | Export SBOM (CycloneDX 1.4) |
| `POST` | `/api/export` | Export CVE, license and dependency results as a zip archive (body: `{ repoId }`) |
| `POST` | `/api/repos/sync` | Sync repositories from GitHub |
| `GET` | `/api/policies` | List policy rules |
| `POST` | `/api/policies` | Create or update a policy rule |
| `POST` | `/api/dependabot` | Enable Dependabot alerts for a repo (body: `{ repoId }`) |
| `GET` | `/api/dependabot/check` | Check which repos have Dependabot disabled |
| `POST` | `/api/dependabot/enable-all` | Bulk-enable Dependabot across all repos |
| `POST` | `/api/ci/sync` | Trigger a ci-insights sync (requires Bearer token; optional body `{ repoId }`, omit to sync all tracked repos) |
| `GET` | `/api/health` | Health check (returns service status). Public, no auth required |

## MCP server

For agent access, depsight ships an MCP server in [`mcp/`](../mcp/README.md) that exposes read-only queries (CVEs, licenses, deps, policies, CI analytics) to Claude and other MCP-capable clients.
