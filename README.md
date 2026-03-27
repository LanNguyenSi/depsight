# depsight

GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories — with timelines, risk scores, and compliance export.

## Tech Stack

- **Framework:** Next.js (App Router)
- **Language:** TypeScript
- **Database:** Postgresql + Prisma ORM
- **Styling:** Tailwind CSS 4
- **Auth:** JWT
- **Deployment:** Docker + Traefik
## Quick Start

### Prerequisites

- Node.js 20+
- Docker (for Postgresql)

### Setup

```bash
npm install
cp .env.example .env
# Edit .env with your database URL

npx prisma migrate dev --name init
npx prisma generate
npm run dev
```

### Docker Deployment

```bash
# Build and start
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
