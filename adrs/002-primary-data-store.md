# ADR-002: Primary Data Store

## Status
Accepted

## Context

depsight needs to persist:
- Users + GitHub OAuth tokens
- Tracked repositories per user
- CVE scan results with severity + timestamps (for timeline charts)
- License scan results
- Policy rules
- Scan job state

Timeline/history features require efficient time-series queries over scan results.

## Decision

**PostgreSQL via Prisma ORM.**

- Single relational DB for all entities
- CVE scan results stored as rows with `scannedAt` timestamps → enables timeline queries
- JSONB columns for raw advisory payloads (flexible, avoids schema churn)
- No separate time-series DB in Phase 1

## Rationale

- PostgreSQL handles time-series queries well enough for Phase 1 scale (hundreds of repos, not millions)
- Prisma gives type-safe queries and easy migrations
- JSONB for raw payloads avoids over-engineering the schema before data shapes stabilize

## Consequences

### Positive
- Single DB to operate
- Prisma migrations keep schema evolvable
- JSONB flexible for advisory data variance across ecosystems

### Negative
- Not optimized for high-frequency scan writes at scale
- Timeline aggregations may need indexes tuned later

### Follow-Up
- Add indexes on `(repoId, scannedAt)` from day 1
- Consider TimescaleDB or ClickHouse if scan frequency × repo count grows beyond ~10M rows
