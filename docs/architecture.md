# Architecture — depsight

## Overview

Full-stack Next.js application with App Router.

## Layers

| Layer | Location | Purpose |
|-------|----------|---------|
| Pages | `app/` | Route handlers (Server Components) |
| API | `app/api/` | REST endpoints |
| Components | `components/` | Reusable UI |
| Library | `lib/` | Business logic, auth, utilities |
| Database | `prisma/` | Schema, migrations |

## Data Flow

```
Browser → Next.js Server Component → Prisma → Postgresql
Browser → API Route → Prisma → Postgresql
```

## Key Decisions

See `.ai/DECISIONS.md` for architecture decision records.
