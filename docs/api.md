# API reference

All endpoints require authentication via NextAuth session or Bearer token.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Trigger CVE scan for a repository |
| `POST` | `/api/license` | Run license compliance check |
| `GET` | `/api/deps` | Fetch dependency list with age/outdated info |
| `GET` | `/api/sbom` | Export SBOM (CycloneDX 1.4) |
| `GET` | `/api/export` | Download repository data as zip |
| `POST` | `/api/repos/sync` | Sync repositories from GitHub |
| `GET` | `/api/policies` | List policy rules |
| `POST` | `/api/policies` | Create or update a policy rule |
| `GET` | `/api/dependabot` | Check Dependabot status for a repository |
| `POST` | `/api/dependabot/enable-all` | Bulk-enable Dependabot across all repos |
| `POST` | `/api/ci/sync` | Trigger a ci-insights sync (requires Bearer token) |
| `GET` | `/api/health` | Health check (returns service status) |

## MCP server

For agent access, depsight ships an MCP server in [`mcp/`](../mcp/README.md) that exposes read-only queries (CVEs, licenses, deps, policies, CI analytics) to Claude and other MCP-capable clients.
