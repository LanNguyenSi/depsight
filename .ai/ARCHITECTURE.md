# .ai/ARCHITECTURE.md — System Architecture

> Read this to understand the system before making changes.

## Overview

**depsight** is a full-stack Next.js application.

```
depsight/
├── app/
│   ├── (public)/          → Public pages (listing, detail, booking)
│   ├── admin/             → Admin panel (dashboard, CRUD, analytics)
│   ├── api/               → API routes (REST endpoints)
│   ├── globals.css        → Global styles (@import "tailwindcss")
│   └── layout.tsx         → Root layout
├── components/
│   ├── public/            → Public-facing components
│   ├── admin/             → Admin components
│   └── shared/            → Shared components
├── lib/
│   ├── prisma.ts          → Prisma client singleton
│   ├── auth.ts            → JWT auth helpers
│   ├── email.ts           → Email service (nodemailer)
│   └── utils.ts           → Shared utilities
├── prisma/
│   └── schema.prisma      → Database schema
├── .ai/                   → Agent context (this folder)
├── Dockerfile             → Multi-stage production build
├── docker-compose.yml     → Local development
└── docker-compose.traefik.yml → Production with Traefik
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js (App Router, Server Components) |
| Language | TypeScript (strict mode) |
| Database | Postgresql via Prisma ORM |
| Styling | Tailwind CSS 4 |
| Auth | JWT |
| Deployment | Docker + Traefik (SSL via Let's Encrypt) |
| Markdown | react-markdown + remark-gfm |

## Key Patterns

### Server Components (Default)
All pages are Server Components by default. They fetch data directly from DB.
Pages with DB queries need: `export const dynamic = "force-dynamic";`

### API Routes
REST endpoints in `app/api/`. Auth via JWT Bearer token.
All DB mutations that affect related data use `prisma.$transaction()`.

### Client Components
Only used when needed: forms, interactive buttons, state management.
Marked with `'use client';` at the top.

### Authentication
JWT tokens stored in `localStorage` as `admin_token`.
Auth helpers in `lib/auth.ts`: `generateToken()`, `verifyToken()`, `extractToken()`.
Protected API routes check: `const token = extractToken(authHeader); const admin = verifyToken(token);`

## Database

Schema defined in `prisma/schema.prisma`.
After schema changes:
1. `npx prisma migrate dev --name <description>`
2. `npx prisma generate`
3. Restart dev server

## Deployment

### Docker (Production)
Multi-stage Dockerfile: deps → builder → runner.
Important: `prisma generate` runs in BOTH deps AND builder stages.

```bash
docker compose -f docker-compose.traefik.yml build --no-cache app
docker compose -f docker-compose.traefik.yml up -d
```

### Traefik
Reverse proxy with automatic SSL (Let's Encrypt).
Services are routed via Docker labels.
