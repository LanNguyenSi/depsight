# ADR-003: GitHub API Strategy

## Status
Accepted

## Context

depsight relies on GitHub for:
- OAuth authentication
- Repository discovery
- Vulnerability alerts (CVEs)
- Future: PR comments, webhook events

GitHub API has rate limits: 5,000 req/hour authenticated.

## Decision

**Use GitHub REST API v3 with user OAuth token. Cache results in DB.**

- CVE data: `GET /repos/{owner}/{repo}/vulnerability-alerts` (requires Dependabot alerts enabled)
- Fallback: `GET /repos/{owner}/{repo}/dependency-graph/sbom` for SBOM + manual CVE lookup
- Always store API responses in DB with `fetchedAt` timestamp
- Re-fetch only when older than configurable TTL (default: 6h)
- Respect `Retry-After` headers on 429

## Rationale

- User token keeps scans scoped to repos the user can actually see
- Caching prevents rate limit exhaustion for users with many repos
- REST API sufficient for Phase 1; GraphQL if batch performance becomes an issue

## Consequences

### Positive
- Simple implementation, well-documented API
- User-scoped data (no cross-user data leakage)
- TTL cache reduces API calls significantly

### Negative
- Users must have Dependabot alerts enabled on their repos
- Stale data possible within TTL window

### Follow-Up
- Surface "Dependabot alerts not enabled" as a warning in UI
- Add manual "rescan" button that bypasses TTL
