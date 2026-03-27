# depsight

GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories — with timelines, risk scores, and compliance export.

## Tech Stack

- **Framework:** Next.js (App Router)
- **Language:** TypeScript
- **Database:** Postgresql + Prisma ORM
- **Styling:** Tailwind CSS 4
- **Auth:** JWT
- **Deployment:** Docker + Traefik
## Features

- GitHub OAuth login and repository discovery
- CVE scanning per repository (severity breakdown)
- License detection and compatibility checking
- Dependency age tracking and outdated alerts
- Vulnerability timeline and risk score history
- Cross-repo comparison and team health overview
- SBOM export (CycloneDX format)
- Policy engine for custom CVE/license rules
- PR integration with automatic CVE comments
- Webhook and Slack notifications

## Quick Start

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your GitHub OAuth credentials and JWT secret

# 3. Start PostgreSQL and app
docker compose -f docker-compose.dev.yml up

# Access: http://localhost:3000
```

### Database Management

```bash
# Generate Prisma client
npm run db:generate

# Push schema changes (dev)
npm run db:push

# Create migration (production)
npx prisma migrate dev --name <migration_name>

# Database GUI
npm run db:studio
```

### Production Deployment

```bash
# Build and start with Traefik (SSL + reverse proxy)
docker compose -f docker-compose.traefik.yml build --no-cache app
docker compose -f docker-compose.traefik.yml up -d
```

## Project Structure

```
├── app/(public)/      Public pages
├── app/admin/         Admin panel
├── app/api/           REST API routes
├── components/        UI components
├── lib/               Shared utilities
├── prisma/            Database schema
├── .ai/               Agent context files
└── docs/              Documentation
```

## AI Agent Context

This project includes `.ai/` files for AI coding agents:

- `.ai/AGENTS.md` — Team roles and workflow
- `.ai/ARCHITECTURE.md` — System overview
- `.ai/TASKS.md` — Work packages
- `.ai/DECISIONS.md` — Architecture decisions

## License

MIT

---

Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit)
