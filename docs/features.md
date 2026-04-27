# Features

A complete list of what depsight does today, beyond the headline value props in the README.

## Core scans

- **CVE scanning** per repository: severity breakdown, risk scores, vulnerability timeline, risk score history.
- **License detection** and copyleft compliance checking across all supported ecosystems.
- **Dependency age tracking** and outdated alerts.
- **Multi-ecosystem support:** npm, Python, Go, Java, Rust, PHP.

## Reporting and export

- **SBOM export** in CycloneDX 1.4 format.
- **Repository export** (download as zip).
- **Cross-repo comparison** and team health overview.

## Workflow integrations

- **GitHub OAuth** login and repository discovery.
- **PR integration** with automatic CVE comments.
- **Webhook and Slack notifications.**
- **Dependabot integration:** status check, enable per-repo, bulk-enable across all repos.

## Policy engine

Custom CVE and license rules: define what severity / license combinations are allowed, denied, or require a waiver. See the `/api/policies` endpoint in [docs/api.md](api.md).

## CI Health

Workflow fail rates, build times, flaky-job detection. Powered by the companion [ci-insights](https://github.com/LanNguyenSi/ci-insights) service. See the [CI Health setup](configuration.md#ci-health-ci-insights-integration) section for how to wire it up.

## MCP server

Read-only queries (CVEs, licenses, deps, policies, CI analytics) exposed to Claude and other agents via [`mcp/`](../mcp/README.md).

## Operational

- **Health check endpoint:** `GET /api/health` returns service status.
