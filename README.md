# depsight

GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories.

**Live Demo:** [depsight.opentriologue.ai](https://depsight.opentriologue.ai/)

## Tech Stack

- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **Database:** PostgreSQL 16 + Prisma ORM
- **Styling:** Tailwind CSS 4
- **Auth:** NextAuth v5 (GitHub OAuth + Dev Credentials)
- **Deployment:** Docker (multi-stage build)

## Features

- GitHub OAuth login and repository discovery
- CVE scanning per repository (severity breakdown, risk scores)
- License detection and copyleft compliance checking
- Dependency age tracking and outdated alerts
- Multi-ecosystem support: **npm, Python, Go, Java, Rust, PHP**
- Vulnerability timeline and risk score history
- Cross-repo comparison and team health overview
- SBOM export (CycloneDX 1.4 format)
- Policy engine for custom CVE/license rules
- PR integration with automatic CVE comments
- Webhook and Slack notifications

## Quick Start

```bash
# Single command — installs deps, starts DB, migrates, runs dev server
make dev
```

This starts the full Docker environment (app + PostgreSQL). Access at **http://localhost:3000**.

In development, a **Dev Login** is available on the login page — no GitHub OAuth credentials needed.

### With GitHub OAuth (optional)

```bash
cp .env.example .env
# Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
make dev
```

### Other Make targets

```bash
make dev-up      # Start in background
make dev-down    # Stop
make dev-logs    # Tail logs
make dev-clean   # Stop + delete DB volumes
make prod        # Production build + start
make test        # Run tests
make lint        # Linting + type-checking
make ci          # Full CI pipeline
```

### Database Management

```bash
# These run inside the Docker container automatically on `make dev`.
# For manual use:
npm run db:generate    # Generate Prisma client
npm run db:push        # Push schema changes (dev)
npm run db:studio      # Database GUI
```

## Project Structure

```
app/
  api/              API routes (auth, scan, license, deps, sbom, ...)
  dashboard/        Main dashboard (repo list, CVE/license/deps tabs)
  overview/         Team health overview + repo comparison
  policies/         Policy management
  login/            Login page
components/         Shared UI components
lib/
  cve/              CVE scanner
  deps/             Dependency age scanners (npm, python, go, java, rust, php)
  license/          License scanners (npm, python, go, java, rust, php)
  sbom/             CycloneDX SBOM generator
  policy/           Policy engine
  overview/         Team health aggregation
prisma/             Database schema
docker/             Docker entrypoints
```

## License

MIT

---

Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit)
