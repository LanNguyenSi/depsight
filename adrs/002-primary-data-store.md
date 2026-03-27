# ADR-002: Primary Data Store

## Context

Project: depsight

Summary: GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories — with timelines, risk scores, and compliance export.

## Decision

Use a relational primary data store unless the domain clearly requires a different model.

## Consequences

### Positive

- Faster alignment on a high-leverage decision.
- Better reviewability for future changes.

### Negative

- This decision may need revision as requirements sharpen.

### Follow-Up

- Validate this ADR during the first implementation wave.
- Update if significant scope or risk assumptions change.
