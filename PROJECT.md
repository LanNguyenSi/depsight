# PROJECT: depsight

## Purpose

This file is the human-first operating index for the generated planning pack.
Use it to understand the current plan quickly and jump to the source artifacts that carry the detailed truth.

## Current Planning Snapshot

- Summary: GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories — with timelines, risk scores, and compliance export.
- Planner profile: product
- Phase: phase_1
- Path: core
- Intake completeness: partial
- Data sensitivity: low
- Recommended architecture: Start with modular monolith as the default architecture.

## Source Artifacts

- [Project Charter](project-charter.md): scope, users, constraints, open questions
- [Architecture Overview](architecture-overview.md): starting architecture, tradeoffs, risks
- [Delivery Plan](delivery-plan.md): execution waves and dependency ordering
- [Task Backlog](tasks/): executable work packages with acceptance criteria
- [ADRs](adrs/): early high-leverage decisions
- [Prompts](prompts/): downstream agent handoff prompts
- [.ai/](.ai/): compact AI-facing execution context

## Recommended Working Order

1. Read `project-charter.md` for scope and unresolved questions.
2. Read `architecture-overview.md` to confirm the recommended starting shape still fits.
3. Read `delivery-plan.md` to understand wave sequencing and dependencies.
4. Execute or refine the current wave tasks under `tasks/`.
5. Update ADRs and prompts when architectural or governance assumptions move.

## Current Wave

### wave-1

Lock scope, assumptions, and engineering baseline.

- 001 Write project charter and architecture baseline
- 002 Set up repository and delivery baseline

## Wave Summary

- wave-1: Lock scope, assumptions, and engineering baseline. (2 tasks)
- wave-2: Deliver the first critical capabilities and required controls. (2 tasks)
- wave-3: Expand feature coverage once the core path is in place. (8 tasks)
- wave-4: Harden, verify, and prepare the system for release. (1 tasks)

## Architecture Guardrails

- This option offers the best balance between delivery speed and long-term maintainability.
- It avoids premature distributed complexity while keeping room for future extraction.

## Key Risks

- None

## Open Questions

- None

## Guidance Areas To Keep Visible

- project setup
- architecture
- development workflow
- testing strategy
- quality assurance
- documentation

## Artifact Expectations

- project-charter.md
- architecture-overview.md
- adrs/
- tasks/

## Notes

- `PROJECT.md` is a generated index, not the detailed source of truth.
- When detailed plan artifacts disagree, prefer `plan-output.json`, task documents, and ADRs over summary text here.
- If the plan changes materially, rerun the planner so this file stays aligned with the backlog.
