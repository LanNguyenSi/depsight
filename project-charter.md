# Project Charter: depsight

## Summary

GitHub-connected developer security dashboard for tracking CVEs, license risks, and dependency health across repositories — with timelines, risk scores, and compliance export.

## Target Users

- developers
- engineering leads
- compliance teams

## Core Features

- GitHub OAuth login and repository discovery
- CVE scanning per repository with severity breakdown
- License detection and compatibility conflict flagging
- Dependency age tracking and outdated package alerts
- Vulnerability timeline and risk score history per repo
- Cross-repo comparison and team health overview
- SBOM export in CycloneDX format
- Policy engine for custom license and CVE rules
- PR integration with automatic CVE comment on new vulnerabilities
- Webhook and Slack notifications for critical CVEs

## Constraints

- TypeScript
- Next.js fullstack
- PostgreSQL
- GitHub OAuth via next-auth
- must run in Docker

## Non-Functional Requirements

- None

## Delivery Context

- Planner profile: product
- Intake completeness: partial
- Phase: phase_1
- Path: core
- Data sensitivity: low

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

## Missing Information

- Non-functional requirements are not defined.

## Follow-Up Questions

- What non-functional expectations matter most: performance, availability, security, auditability, or scalability?
- Are there external integrations, identity providers, or messaging systems the product must rely on?

## Open Questions

- None
