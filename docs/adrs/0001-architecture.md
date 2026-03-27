# ADR-0001: Next.js Full-Stack Architecture

**Date:** now
**Status:** Accepted

## Context

Need a full-stack web application with server-side rendering, API routes, and good developer experience.

## Decision

Use Next.js App Router with:
- Server Components (default)
- Prisma ORM for type-safe database access
- Tailwind CSS 4 for styling
- JWT for authentication
- Docker + Traefik for deployment
## Consequences

### Positive
- Single framework for frontend + backend
- Type-safe from DB to UI (Prisma → TypeScript → React)
- Built-in SSR, API routes, image optimization
- Easy deployment as single container

### Negative
- Server Components require `force-dynamic` for DB access
- Client interactivity needs explicit `'use client'`
- Prisma Client must be regenerated after schema changes
