# Architecture

depsight is a full-stack Next.js application with the App Router, backed by PostgreSQL via Prisma, and shipped as a Docker image (multi-stage build).

## Tech stack

- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript (strict mode)
- **Database:** PostgreSQL 16 + Prisma ORM
- **Styling:** Tailwind CSS 4
- **Auth:** NextAuth v5 beta (GitHub OAuth + Dev Credentials)
- **Deployment:** Docker (multi-stage build)

## Layers

| Layer | Location | Purpose |
|-------|----------|---------|
| Pages | `app/` | Route handlers (Server Components) |
| API | `app/api/` | REST endpoints |
| Components | `components/` | Reusable UI |
| Library | `lib/` | Business logic, auth, utilities |
| Database | `prisma/` | Schema, migrations |

## Project structure

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

## Data flow

```
Browser → Next.js Server Component → Prisma → Postgresql
Browser → API Route → Prisma → Postgresql
```

## Key decisions

See [`docs/adrs/`](adrs/) for architecture decision records.
