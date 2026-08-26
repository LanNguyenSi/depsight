# depsight-mcp

Model Context Protocol server for [depsight](https://github.com/LanNguyenSi/depsight) — query CVE scans, license reports, dependency age, policy evaluation, and CI analytics from Claude (or any MCP-capable agent).

This is a thin wrapper around depsight's existing Next.js REST API. It does not talk to the database directly.

## Tools

| Name | Purpose |
|---|---|
| `depsight_list_repos` | List the user's GitHub repos (source of `repoId` values) |
| `depsight_get_overview` | Team-health dashboard summary across all tracked repos |
| `depsight_get_cves` | Get the latest CVE scan for a repo, with optional min-severity / since-date filters |
| `depsight_get_license_report` | Per-package license compatibility + policy violations |
| `depsight_get_deps` | Dependency-age analysis (up-to-date / outdated / major-behind / deprecated) |
| `depsight_get_history` | Time series of CVE scan results for a repo |
| `depsight_evaluate_policy` | Run enabled policies against a specific scan |
| `depsight_ci_analytics` | GitHub Actions CI insights — per-repo (with `repoId`) or cross-repo (without) |
| `depsight_get_sbom` | Export the CycloneDX 1.4 SBOM for a repo (requires a completed scan) |
| `depsight_list_policies` | List the user's configured dependency policies |
| `depsight_rescan` | Trigger a synchronous CVE scan for a tracked repository (the one write tool) |

All tools are **read-only** except `depsight_rescan`, which triggers a CVE scan for a tracked repository. Webhook management and policy mutation are not exposed.

## Prerequisites

1. **A running depsight instance.** Either local (`npm run dev`, default `http://localhost:3000`) or hosted.
2. **A depsight API token (`dsat_…`).** See [minting a token](#minting-a-token) below.

## Install + run

```bash
# One-off via npx (published on npm via the release workflow; see Releasing below)
npx -y @opentriologue/depsight-mcp

# Or locally from this repo after `npm run build`
node /path/to/depsight/mcp/dist/index.js
```

The server speaks MCP over stdio — launch it via your agent's MCP client config, not directly from a terminal.

### Claude Desktop / Claude Code config

```json
{
  "mcpServers": {
    "depsight": {
      "command": "npx",
      "args": ["-y", "@opentriologue/depsight-mcp"],
      "env": {
        "DEPSIGHT_URL": "https://depsight.opentriologue.ai",
        "DEPSIGHT_API_TOKEN": "dsat_..."
      }
    }
  }
}
```

Both env vars are **required**; the server aborts on startup otherwise.

## Minting a token

API tokens live in the `ApiToken` Prisma model, are scoped to a single depsight user, and each carries a `READ` or `WRITE` scope. Inside the depsight repo:

```bash
# ensure DATABASE_URL is set in your shell

# READ token: everything except depsight_rescan (recommended default for most agents)
npx tsx scripts/mint-api-token.ts --user <userId> --name claude-desktop --scope READ

# WRITE token: also allows depsight_rescan (only needed if the agent triggers scans)
npx tsx scripts/mint-api-token.ts --user <userId> --name claude-desktop --scope WRITE
```

`--scope` defaults to `WRITE` when omitted, matching this script's behaviour from before the scope field existed; pass `--scope READ` explicitly for a read-only token. Every tool in the table above except `depsight_rescan` works with a `READ` token; `depsight_rescan` (`POST /api/scan`) requires `WRITE` and returns a 403 for a `READ` token. Since v1 does not expose policy mutation or webhook management (see Scope / limitations below), no other shipped tool needs `WRITE` today.

The raw `dsat_…` value is printed **once**. Store it in your agent config (env var, secret manager); there is no retrieve-existing endpoint. To rotate, mint a new one and `UPDATE "ApiToken" SET "revokedAt" = NOW() WHERE id = '…';` on the old row.

All data is scoped to the minting user: tools only see repos that user owns.

## Smoke test

After setting env vars:

```bash
# From the mcp/ directory
npm run build

# 1) Discover tools (handshake + tools/list)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | DEPSIGHT_URL=http://localhost:3000 DEPSIGHT_API_TOKEN=dsat_... node dist/index.js

# 2) Real round-trip against the depsight API — lists repos
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"depsight_list_repos","arguments":{}}}' \
  | DEPSIGHT_URL=http://localhost:3000 DEPSIGHT_API_TOKEN=dsat_... node dist/index.js
```

Should print a JSON-RPC response listing the 11 tools, then a second response with the user's GitHub repos. In Claude Code, ask *"list my depsight repos with critical CVEs"* — the agent should call `depsight_list_repos` then `depsight_get_cves` with `minSeverity: "CRITICAL"` per repo.

## Error handling

Tool handlers never throw. On any failure (network, HTTP non-2xx, parse error), they return:

```json
{
  "content": [{ "type": "text", "text": "{\"success\":false,\"error\":\"…\"}" }],
  "isError": true
}
```

HTTP errors carry the upstream status code and response body so you can tell a 401 (bad token) apart from a 404 (wrong `repoId`).

## Scope / limitations

- Read-only except `depsight_rescan` (scan trigger). v1 intentionally omits the other write operations (webhook management, policy mutation, Slack config).
- Per-token ACL via `ApiToken.scope`: a `READ` token can call every read tool, but `depsight_rescan` (the one write tool) requires a `WRITE` token and 403s for a `READ` token. There is still no finer-grained per-tool ACL beyond the read/write split.
- No pagination beyond what the underlying REST endpoints already expose. Very large repos may produce large JSON responses.
- Tokens never expire automatically. Operators must rotate manually.

## Development

```bash
npm install
npm run dev        # runs against DEPSIGHT_URL + DEPSIGHT_API_TOKEN via tsx
npm test           # vitest
npm run build      # emits dist/
```

## Releasing

Publishing is tag-driven via [`.github/workflows/publish-npm.yml`](../.github/workflows/publish-npm.yml),
kept separate from the app's `v*` releases so the two never collide.

```bash
# 1. Bump the version in mcp/package.json (e.g. 0.2.0 -> 0.2.1)
# 2. Commit, then push a tag whose suffix matches that version:
git tag depsight-mcp-v0.2.1
git push origin depsight-mcp-v0.2.1
```

The workflow checks `mcp/package.json` version against the tag, builds, and runs
`npm publish --access public --provenance`. Publishing is tokenless via npm
Trusted Publishing (OIDC): the package needs a Trusted Publisher entry on
npmjs.com (repo `LanNguyenSi/depsight`, workflow `publish-npm.yml`; operator
one-time setup); no `NPM_TOKEN` secret is required.
