# Prompt: Delivery Execution

You are working on `depsight`.

## Objective

Turn the current plan into an implementation strategy for the next delivery wave.
Use a spec/context/eval lens:

- spec: keep the objective, scope, dependencies, and acceptance criteria explicit
- context: use the architecture, constraints, and applicable playbooks to guide decisions
- eval: define the tests, review points, and rollout checks needed before delivery is considered done

## Context

- Planner profile: product
- Phase: phase_1
- Current wave: wave-1
- Wave goal: Lock scope, assumptions, and engineering baseline.
- Critical path: 001 -> 002 -> 003 -> 013

## Tasks In Scope

- 001 Write project charter and architecture baseline (P0)
  Depends on: none
- 002 Set up repository and delivery baseline (P0)
  Depends on: 001

## Applicable Playbooks

- /root/.openclaw/workspace/git/agent-planforge/playbooks/planning-and-scoping.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/01-project-setup.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/02-architecture.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/03-team-roles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/04-design-principles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/05-development-workflow.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/06-testing-strategy.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/07-quality-assurance.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/08-documentation.md

## Constraints And Questions

Constraints:
- TypeScript
- Next.js fullstack
- PostgreSQL
- GitHub OAuth via next-auth
- must run in Docker

Open questions:
- None

## Expected Output

- proposed execution order inside the wave
- risks or blockers
- test and verification approach
- whether any task should be split further
