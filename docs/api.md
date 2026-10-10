# API reference

All endpoints except `GET /api/health` and the NextAuth sign-in handlers under `/api/auth/*` require authentication. Which credentials an endpoint accepts depends on the route:

- **Session or Bearer token:** `/api/scan`, `/api/license`, `/api/deps`, `/api/history`, `/api/overview`, `/api/sbom`, `/api/repos`, `/api/repos/tracked-ids`, `/api/policies`, `/api/policies/[id]`, `/api/policies/evaluate`, `/api/advisory-state`, `/api/ci/analytics/*` and `/api/ci/sync` accept either a NextAuth session (the dashboard) or an `Authorization: Bearer dsat_...` API token (headless agents such as the MCP server).
- **Session only:** `/api/export`, `/api/repos/sync`, `/api/dependabot`, `/api/dependabot/check`, `/api/dependabot/enable-all`, `/api/pr-scan`, `/api/me`, `/api/tokens` and `/api/tokens/[id]`, `/api/webhooks` and `/api/webhooks/[id]`, and `/api/slack` reject a Bearer token with 401. Token management is session-only on purpose: a `dsat_` token can never mint, list, or revoke tokens.

A Bearer `dsat_` token carries a `READ` or `WRITE` scope (`POST /api/tokens` accepts an optional `scope` body field, defaulting to `WRITE`); a `READ` token gets 403 on `POST /api/policies`, `PUT`/`DELETE /api/policies/[id]`, `POST /api/ci/sync`, `PUT`/`DELETE /api/advisory-state`, and the three scan-triggering POSTs (`/api/scan`, `/api/license`, `/api/deps`); all other Bearer-capable endpoints work with either scope. A session always has full access.

A session counts only when it carries a user id: a signed-in session whose user row no longer exists has none and is treated as no session (401 on every session-only route, and a Bearer token is then tried on the routes that accept one).

This table is a curated subset; the app exposes more route handlers (e.g. `/api/me`, `/api/tokens`, `/api/webhooks`, `/api/slack`, `/api/history`, `/api/overview`, `/api/pr-scan`, `/api/ci/analytics/*`) than are listed here.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Trigger CVE scan for a repository (body: `{ repoId }`); the answer carries `degradedReason`, null unless a source could not be read; rate limited, see [Rate limits](#rate-limits) |
| `GET` | `/api/scan` | Latest completed CVE scan of a repository (`?repoId=`). Each advisory carries `state`: null while the finding is open, else `{ status: 'ACKNOWLEDGED' \| 'IGNORED', note, setBy, setAt }`. The counts and risk score include ignored findings |
| `PUT` | `/api/advisory-state` | Acknowledge or ignore one finding (body: `{ repoId, ghsaId, packageName, status: 'ACKNOWLEDGED' \| 'IGNORED', note? }`, note up to 500 characters). 404 for a repository the caller does not own or an advisory that repository never reported. Session or `WRITE` Bearer token |
| `DELETE` | `/api/advisory-state` | Clear the state of one finding, it is open again (body: `{ repoId, ghsaId, packageName }`). Idempotent. Session or `WRITE` Bearer token |
| `POST` | `/api/license` | Run license compliance check (body: `{ repoId }`); rate limited, see [Rate limits](#rate-limits) |
| `GET` | `/api/deps` | Fetch dependency list with age/outdated info |
| `POST` | `/api/deps` | Run the dependency age analysis for a repository (body: `{ repoId }`); rate limited, see [Rate limits](#rate-limits) |
| `GET` | `/api/sbom` | Export SBOM (CycloneDX 1.4) |
| `POST` | `/api/export` | Export CVE, license and dependency results as a zip archive (body: `{ repoId }`) |
| `GET` | `/api/repos` | List the live GitHub repos for the authenticated user; archived repos are excluded unless `?includeArchived=true`; rate limited, see [Rate limits](#rate-limits) |
| `GET` | `/api/repos/tracked-ids` | Cheap per-tracked-repo id pair, `{ repos: [{ repoId, githubId }] }`; no team-health computation |
| `POST` | `/api/repos/sync` | Sync repositories from GitHub; archived repos are excluded and untracked; response `{ synced, removed, archived }` |
| `GET` | `/api/policies` | List policy rules |
| `POST` | `/api/policies` | Create or update a policy rule (`LICENSE_DENY`, `LICENSE_ALLOW_ONLY`, `CVE_MIN_SEVERITY`, `DEPENDENCY_MAX_AGE`, `DEPENDENCY_MIN_VERSION`); a `rule` that does not fit the type's shape returns 400 |
| `POST` | `/api/dependabot` | Enable Dependabot alerts for a repo (body: `{ repoId }`) |
| `GET` | `/api/dependabot/check` | Check which repos have Dependabot disabled |
| `POST` | `/api/dependabot/enable-all` | Bulk-enable Dependabot for the caller's tracked repos among the given `repoIds` (body: `{ repoIds }`) |
| `POST` | `/api/ci/sync` | Sync GitHub Actions run data into the CI Health analytics (session or `WRITE` Bearer token; optional body `{ repoId }`, omit to sync all tracked repos); rate limited, see [Rate limits](#rate-limits) |
| `GET` | `/api/health` | Health check (returns service status). Public, no auth required |

## Rate limits

`POST /api/scan`, `POST /api/license`, `POST /api/deps`, `POST /api/ci/sync` and `GET /api/repos` spend the owner's GitHub API quota, so they are limited per user, for a browser session and a `WRITE` Bearer token alike (a `READ` Bearer token too on `GET /api/repos`: a token of either scope spends its owner's GitHub quota there; the limit follows the user the credential resolves to, so several tokens of one user share it). The limit is a fixed one-hour window per user:

| Endpoint | Limit per user and hour |
|----------|-------------------------|
| `POST /api/scan` | 300 |
| `POST /api/license` | 300 |
| `POST /api/deps` | 300 |
| `GET /api/repos` | 300 |
| `POST /api/ci/sync` with a `repoId` | 300 |
| `POST /api/ci/sync` without a `repoId` (30-day sync of every tracked repo) | 12 |

Over the limit the endpoint answers `429` with a `Retry-After` header (whole seconds until the window resets) and a body `{ "error": "Rate limit exceeded", "retryAfterSeconds": <n> }`; no scan, sync or repository listing is started. A request that fails authentication (401) or the write-scope check (403) does not count; every other answer counts, including a 400 for a missing `repoId` and, on `/api/deps`, a 404 for a repository the caller does not own. Every row of the table is its own budget. One `GET /api/repos` call costs ceil(N/100) GitHub requests for N visible repositories, so the limit counts calls, not GitHub requests. The counters live in the app process, which matches the single-instance deployment (one `app` service); behind several instances each instance would enforce the limit separately. The 300 per hour limits sit above the dashboard's "scan all" run for an account with up to 300 tracked repositories (it calls scan, license and deps once per repository, so each endpoint sees at most 300 calls) and above a CI job that syncs one repository after every push (`/api/ci/sync` with a `repoId`).

## MCP server

For agent access, depsight ships an MCP server in [`mcp/`](../mcp/README.md) that exposes queries (CVEs, licenses, deps, policies, CI analytics), SBOM export, and a scan-trigger tool to Claude and other MCP-capable clients; read-only apart from the scan trigger.
