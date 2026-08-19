# Features

A complete list of what depsight does today, beyond the headline value props in the README.

## Core scans

- **CVE scanning** per repository: severity breakdown, risk scores, vulnerability timeline, risk score history.
- **License detection** and copyleft compliance checking across all supported ecosystems.
- **Dependency age tracking** and outdated alerts.
- **Multi-ecosystem support:** npm, Python, Go, Java, Rust, PHP.

## Known limitations

- **CVE scanning does not count Dependabot alerts GitHub auto-dismissed.**
  The Dependabot channel (`lib/cve/github-advisories.ts`) fetches only
  `state: 'open'` alerts. GitHub's "Dismiss low impact issues for
  development-scoped dependencies" auto-triage preset is **on by default for
  public repos** and **opt-in for private repos**; an alert it dismisses is
  never `open`, so it never reaches depsight's counts, risk score, or UI —
  not marked, not tiered, simply absent. This is a deliberate choice, not a
  bug to fix by counting `auto_dismissed` the same as `open`: GitHub's own
  classification already distinguishes "low impact on a dev-only dependency"
  from an actually open finding, and blending the two would misrepresent
  what "open" means in the dashboard.
  - Because the preset's default depends on repo **visibility**, not repo
    content, the same advisory can be `open` on a private repo and
    `auto_dismissed` on a public one with the identical dependency — a
    difference in depsight's counts between two repos can reflect that
    default, not a difference in actual exposure.
  - depsight's independent OSV channel (queries the lockfile directly,
    dev and prod) is not a verified backstop for this gap: it also missed
    the historical case documented in the cve-sweep skill.
  - Cross-check per repo: `gh api "repos/<owner>/<repo>/dependabot/alerts?state=auto_dismissed&per_page=100"`.
    See the cve-sweep skill (`.claude/skills/cve-sweep/SKILL.md`) for the
    full two-channel discovery procedure and each channel's blind spots.

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

## Settings

- **API token management:** mint, view-once, and revoke `dsat_` API tokens from the Settings page.
- **UI language switch:** English / German.

## Operational

- **Health check endpoint:** `GET /api/health` returns service status.
