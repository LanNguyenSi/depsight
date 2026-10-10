# API reference

All endpoints except `GET /api/health`, the NextAuth sign-in handlers under `/api/auth/*` and the GitHub webhook `POST /api/webhooks/github` (authenticated by its HMAC signature, see [GitHub pull-request webhook](#github-pull-request-webhook)) require authentication. Which credentials an endpoint accepts depends on the route:

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
| `POST` | `/api/webhooks/github` | GitHub `pull_request` webhook: scans the PR and posts or updates its CVE comment. No session or token; authenticated by the `X-Hub-Signature-256` HMAC, see [GitHub pull-request webhook](#github-pull-request-webhook) |
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

## GitHub pull-request webhook

`POST /api/webhooks/github` takes GitHub's `pull_request` webhook and runs the same scan as `POST /api/pr-scan`. Setup (secret, payload URL, events) is in [docs/configuration.md](configuration.md#pr-scan-webhook-optional). It has no session and no Bearer token: the only authentication is the HMAC-SHA256 of the raw request body under `GITHUB_WEBHOOK_SECRET`, sent as `X-Hub-Signature-256: sha256=<hex>` and compared in constant time.

**Trust model.** `GITHUB_WEBHOOK_SECRET` is one secret for the whole instance, not one per repository or per user. Whoever holds it can sign a delivery for any repository that any depsight user tracks, and depsight then scans that pull request and posts the comment with the GitHub token of the user who tracks the repository. Treat the secret as operator-only on a multi-user instance, and configure the webhook only on repositories the operator controls (or set the secret only on a single-user instance). On a public repository the comment is public, and GitHub sends the `opened` and `synchronize` deliveries for fork pull requests too, so depsight ignores them (200) unless `GITHUB_WEBHOOK_SCAN_FORKS=true` is set.

| Status | When |
|--------|------|
| `202` | Signed `opened` or `synchronize` delivery for a tracked repository; the scan runs in the background (GitHub allows a delivery 10 seconds) |
| `200` | Signed delivery that is ignored: a `ping`, any other event, any other action (including `reopened`), a repository depsight does not track, or a replayed delivery |
| `400` | Signed delivery with an invalid JSON body, an invalid owner, repository name or PR number, or a missing or malformed `X-GitHub-Delivery` header |
| `401` | Missing, malformed or wrong signature (a signature of the wrong length included) |
| `413` | Body over 1 MiB, rejected without buffering the rest |
| `429` | Rate limit, with a `Retry-After` header |
| `503` | `GITHUB_WEBHOOK_SECRET` unset or blank: the endpoint is disabled and scans nothing |

Only the owner, repository name and PR number of the payload are used; no URL from the payload is ever fetched. The scan uses the GitHub token of the user who tracks the repository (the oldest tracking row with a stored token). A repository tracked by several users is scanned once per delivery, under that one user.

**Replay protection.** A delivery is remembered for 24 hours under its `X-GitHub-Delivery` id and, because that header is not covered by the signature, also under the SHA-256 of its body; a second delivery with either key is answered `200` and ignored. A delivery whose scan fails is forgotten again so GitHub can redeliver it. The memory is bounded (30 000 keys, which is two keys for each of the 600 deliveries per hour the rate limit admits, over the 25 fixed hourly windows a 24-hour memory can span; oldest dropped first) and lives in the app process: a restart clears it, and several instances would each keep their own, which matches the single-instance deployment. The cost of a miss is one repeated scan that rewrites the same PR comment, bounded by the rate limit.

**Rate limit.** Only a signed delivery for a tracked repository counts: 60 per repository and hour, and 600 per hour for the whole endpoint (fixed window, in the app process like the limits above). Unsigned requests and ignored deliveries do not count; there is no per-IP limit, since an unsigned request costs one capped read and one HMAC.

## MCP server

For agent access, depsight ships an MCP server in [`mcp/`](../mcp/README.md) that exposes queries (CVEs, licenses, deps, policies, CI analytics), SBOM export, and a scan-trigger tool to Claude and other MCP-capable clients; read-only apart from the scan trigger.
