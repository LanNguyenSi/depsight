# ADR-001: Initial Architecture Shape

## Status
Accepted

## Context

depsight is a GitHub-connected security dashboard. It needs to:
- Authenticate users via GitHub OAuth
- Fetch and store CVE/license data from GitHub APIs and npm audit
- Display timelines and risk scores per repository
- Eventually support webhooks, PR integration, and SBOM export

The team is small (2 AI agents + 1 human). Speed of iteration matters more than premature separation of concerns.

## Decision

**Modular monolith using Next.js App Router (fullstack).**

- Single Next.js app handles both UI and API routes (`/app/api/`)
- No separate backend service in Phase 1
- PostgreSQL via Prisma for all persistence
- Background scanning via Next.js API routes + DB job queue (no external queue in Phase 1)

## Rationale

- Next.js App Router gives us server components, API routes, and auth in one framework
- Avoids service-to-service complexity before product-market fit
- Easy to extract scanner into a separate service in Phase 2 if needed

## Consequences

### Positive
- Single deploy unit, simple Docker setup
- Shared TypeScript types between UI and API
- Fast iteration

### Negative
- Scanning heavy repos may block API routes → mitigate with async job pattern from day 1
- Harder to scale scanner independently later (acceptable for Phase 1)

### Follow-Up
- If CVE scanning becomes a bottleneck, extract to worker service in Phase 2
- Re-evaluate after Wave 2 completion
