# API reference

All endpoints except `GET /api/health`, the NextAuth sign-in handlers under `/api/auth/*` and the GitHub webhook `POST /api/webhooks/github` (authenticated by its per-repository HMAC signature, see [GitHub pull-request webhook](#github-pull-request-webhook)) require authentication. Which credentials an endpoint accepts depends on the route:

- **Session or Bearer token:** `/api/scan`, `/api/license`, `/api/deps`, `/api/history`, `/api/overview`, `/api/sbom`, `/api/repos`, `/api/repos/tracked-ids`, `/api/policies`, `/api/policies/[id]`, `/api/policies/evaluate`, `/api/advisory-state`, `/api/ci/analytics/*` and `/api/ci/sync` accept either a NextAuth session (the dashboard) or an `Authorization: Bearer dsat_...` API token (headless agents such as the MCP server).
- **Session only:** `/api/export`, `/api/repos/sync`, `/api/dependabot`, `/api/dependabot/check`, `/api/dependabot/enable-all`, `/api/pr-scan`, `/api/me`, `/api/tokens` and `/api/tokens/[id]`, `/api/webhooks` and `/api/webhooks/[id]`, `/api/webhook-secrets` and `/api/webhook-secrets/[repoId]`, and `/api/slack` reject a Bearer token with 401. Token management is session-only on purpose: a `dsat_` token can never mint, list, or revoke tokens.

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
| `POST` | `/api/webhooks/github` | GitHub `pull_request` webhook: scans the PR and posts or updates its CVE comment. No session or token; authenticated by the `X-Hub-Signature-256` HMAC under the secret of the tracked repository it names, see [GitHub pull-request webhook](#github-pull-request-webhook) |
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

`POST /api/webhooks/github` takes GitHub's `pull_request` webhook and runs the same scan as `POST /api/pr-scan`. Setup (secret, payload URL, events) is in [docs/configuration.md](configuration.md#pr-scan-webhook-optional). It has no session and no Bearer token: the only authentication is the HMAC-SHA256 of the raw request body, sent as `X-Hub-Signature-256: sha256=<hex>` and compared in constant time, under the webhook secret of a user who tracks the repository the payload names. The endpoint is always on whenever sealing key material exists (there is no switch), and because the secret belongs to the tracking row it does a database lookup of the repository named by the payload before the signature is verified (an indexed lookup of at most 25 rows). Without key material it answers `503`: `WEBHOOK_SECRET_KEY` or `NEXTAUTH_SECRET` is needed, and a deployment that sets only `AUTH_SECRET` has neither. A stored secret that no longer opens is logged once per process by row id, and the instance-wide `GITHUB_WEBHOOK_SECRET` is ignored with a one-time warning at the first delivery.

**Secrets.** Each tracked repository row carries its own secret, minted and rotated by its owner (session only):

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/webhook-secrets` | The caller's tracked repositories with `configured` (a secret is stored), `usable` (it also opens under the current key material; false for a configured secret sealed under other key material or damaged, which never verifies a delivery and must be rotated) and `rotatedAt`; never the secret |
| `POST /api/webhook-secrets/[repoId]` | Mint the secret, or rotate it (the old one stops verifying at once). The response `{ secret, rotatedAt, repository }` is the only time the plaintext is shown (`Cache-Control: no-store`). `404` for a repository the caller does not own, `409` for an untracked one, `503` without sealing key material, `429` over 60 calls per hour |
| `DELETE /api/webhook-secrets/[repoId]` | Remove the secret; `404` for a repository the caller does not own |

**Trust model.** depsight looks up the tracked repositories named by the payload (`repository.owner.login`, `repository.name`) that have a secret, tries the signature against each candidate's secret (at most 25 rows, constant-time compare, no early exit), and acts only for the row whose secret verifies, with that user's GitHub token. A secret therefore only ever authorises scans of its own repository under its own owner: when users A and B both track a repository, a delivery signed with B's secret scans under B and never under A, and B's secret signed over a payload naming a repository only A tracks verifies against nothing. There is no instance-wide secret. Unsigned, wrongly signed, unknown-repository, untracked-repository and no-secret deliveries all get the same `401`, so the status and body do not reveal which repositories are tracked. The response time can still differ: a delivery for a tracked repository costs one HMAC per candidate row, an unknown one costs a single HMAC, so a caller measuring latency can tell a tracked repository from an untracked one (a residual; the 401 itself says nothing). On a public repository the comment is public, and GitHub sends the `opened` and `synchronize` deliveries for fork pull requests too, so depsight ignores them (200) unless `GITHUB_WEBHOOK_SCAN_FORKS=true` is set. The fork check runs after the signature check (only a caller holding a valid secret ever sees that answer) and before the replay guard and the rate limiters (a fork delivery spends no scan budget).

| Status | When |
|--------|------|
| `202` | Verified `opened` or `synchronize` delivery from a pull request in the same repository (or from a fork when `GITHUB_WEBHOOK_SCAN_FORKS=true`); the scan runs in the background (GitHub allows a delivery 10 seconds) |
| `200` | Verified delivery that is ignored: a `ping`, any other event, any other action (including `reopened`), a pull request from a fork (unless `GITHUB_WEBHOOK_SCAN_FORKS=true`; a deleted fork with a null head repository counts as a fork, compared case-insensitively), or a replayed delivery |
| `400` | Verified delivery with an invalid pull request number or a missing or malformed `X-GitHub-Delivery` header |
| `401` | Nothing verified: missing, malformed or wrong signature (wrong length included), a body that is not JSON or names no valid repository, a repository that is not tracked or has no secret |
| `413` | Body over 1 MiB, rejected without buffering the rest |
| `429` | Rate limit, with a `Retry-After` header |
| `503` | No sealing key material (`WEBHOOK_SECRET_KEY` and `NEXTAUTH_SECRET` both unset or blank): the endpoint is disabled and scans nothing |

Only the PR number, action and head repository name of a verified payload are used (and the owner and repository name for the lookup); no URL from the payload is ever fetched. The scan uses the repository, owner and GitHub token of the verified row.

**Replay protection.** A delivery is remembered for 24 hours under its `X-GitHub-Delivery` id and, because that header is not covered by the signature, also under the SHA-256 of its body; a second delivery with either key for the same tracking row is answered `200` and ignored. The keys are scoped to the verified row, so one user cannot make another user's delivery look like a duplicate. A delivery whose scan fails is forgotten again so GitHub can redeliver it. The memory is bounded (150 000 keys, roughly 25 MB at the cap, which is two keys for each of the 3000 deliveries per hour the endpoint-wide ceiling admits, over the 25 fixed hourly windows a 24-hour memory can span; oldest dropped first) and lives in the app process: a restart clears it, and several instances would each keep their own, which matches the single-instance deployment. The cost of a miss is one repeated scan that rewrites the same PR comment, bounded by the rate limit.

**Rate limit.** Only a delivery verified against a tracked row, and not ignored as a fork, counts: 60 per tracking row (one budget per user and repository) and hour, 120 per hour for all of one user's rows together, and 3000 per hour for the whole endpoint (fixed windows, in the app process like the limits above). Rejected and ignored deliveries do not count. The scans a delivery starts spend the tracking user's own GitHub quota, which the per-row and per-user budgets already bound; the endpoint-wide figure is a ceiling that protects the server, not a scan budget. Verifying one delivery costs at most about 9 ms at the 1 MiB body cap with 25 candidate rows (measured: about 0.35 ms of HMAC per candidate per MiB and about 0.36 ms of JSON parse per MiB), so the ceiling means under 30 s of verification CPU per hour. On an instance with open sign-in, enough accounts that each track a repository and mint a secret can still use up that ceiling together and make other users' deliveries answer `429` for the rest of the hour (a residual; the operator can restrict who may sign in). There is no per-IP limit: a request without a well-formed signature costs one capped read, and one with a well-formed signature costs one JSON parse, one indexed lookup and at most 25 HMACs.

## MCP server

For agent access, depsight ships an MCP server in [`mcp/`](../mcp/README.md) that exposes queries (CVEs, licenses, deps, policies, CI analytics), SBOM export, and a scan-trigger tool to Claude and other MCP-capable clients; read-only apart from the scan trigger.
