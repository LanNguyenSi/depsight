# depsight

GitHub-connected security dashboard: CVEs, licenses, and dep health, self-hosted.

**Live demo:** [depsight.opentriologue.ai](https://depsight.opentriologue.ai/). Dev Login is on the login page; no credentials needed to look around.

<!-- TODO(hero): replace this comment with a hero screenshot of the dashboard, e.g. ![](docs/img/dashboard.png). The "tiny demo output" requirement currently leans on the Live Demo link instead. -->

## Try it in 60 seconds

```bash
git clone https://github.com/LanNguyenSi/depsight.git
cd depsight
make dev          # docker compose up: app + Postgres, runs migrations, starts dev server
```

Open http://localhost:3000 and click **Dev Login**. No GitHub OAuth credentials needed for a first look. Add `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` to `.env` to connect real repos. See [docs/configuration.md](docs/configuration.md) for env vars and Make targets.

## What it answers

- **Which of my repos has open CVEs?** Per-repo severity breakdown, risk scores, vulnerability timeline.
- **Which licenses am I shipping?** Copyleft detection and policy-driven compliance across npm, Python, Go, Java, Rust, PHP.
- **Which deps are stale?** Age tracking and outdated alerts, plus Dependabot status (and bulk-enable across all repos).

Plus PR auto-comments on CVEs, Slack/webhook alerts, SBOM export (CycloneDX 1.4), and a policy engine for custom CVE/license rules. Full feature list in [docs/features.md](docs/features.md).

## Why depsight

Dependency trees rot quietly. A CVE disclosed today against a transitive dependency you installed six months ago won't surface until something fails, or until a customer asks. depsight does continuous CVE, license, and staleness scanning across every repo a team owns, so the answer to "are we shipping known-vulnerable code right now?" is a glance at a dashboard rather than an afternoon of manual audits.

For the broader operational picture beyond security, see [agent-ops-dashboard](https://github.com/LanNguyenSi/agent-ops-dashboard), which complements depsight with a fleet-wide repo-health view.

## Next steps

| If you want to... | Read |
|------|------|
| Configure env vars, Make targets, OAuth, the CI Health (ci-insights) integration | [docs/configuration.md](docs/configuration.md) |
| Browse the REST API surface | [docs/api.md](docs/api.md) |
| Understand the architecture (Next.js App Router, Prisma, project layout) | [docs/architecture.md](docs/architecture.md) |
| Wire depsight up to Claude or another MCP-capable agent | [`mcp/README.md`](mcp/README.md) |

## Roadmap

- [ ] Improved CVE auto-triage and severity override rules
- [ ] Scheduled scan support (cron-based rescans)
- [ ] Expanded ecosystem coverage (Ruby, .NET)
- [ ] Dashboard widgets and customizable views
- [ ] Team-level access controls and role management

## License

MIT.

---

Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit).
