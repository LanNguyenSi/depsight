# ADR-001: Initial Architecture Shape

## Context

Project: depsight

Summary: GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories — with timelines, risk scores, and compliance export.

## Decision

Start with modular monolith as the default architecture.

## Consequences

### Positive

- Faster alignment on a high-leverage decision.
- Better reviewability for future changes.

### Negative

- This decision may need revision as requirements sharpen.

### Follow-Up

- Validate this ADR during the first implementation wave.
- Update if significant scope or risk assumptions change.
