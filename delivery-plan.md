# Delivery Plan

## Execution Waves

## wave-1

Lock scope, assumptions, and engineering baseline.

- 001 Write project charter and architecture baseline
- 002 Set up repository and delivery baseline

## wave-2

Deliver the first critical capabilities and required controls.

- 003 Implement GitHub OAuth login and repository discovery
- 004 Implement CVE scanning per repository with severity breakdown

## wave-3

Expand feature coverage once the core path is in place.

- 005 Implement License detection and compatibility conflict flagging
- 006 Implement Dependency age tracking and outdated package alerts
- 007 Implement Vulnerability timeline and risk score history per repo
- 008 Implement Cross-repo comparison and team health overview
- 009 Implement SBOM export in CycloneDX format
- 010 Implement Policy engine for custom license and CVE rules
- 011 Implement PR integration with automatic CVE comment on new vulnerabilities
- 012 Implement Webhook and Slack notifications for critical CVEs

## wave-4

Harden, verify, and prepare the system for release.

- 013 Add integration and error-handling coverage

## Dependency Edges

- 001 -> 002
- 001 -> 003
- 002 -> 003
- 001 -> 004
- 002 -> 004
- 001 -> 005
- 002 -> 005
- 001 -> 006
- 002 -> 006
- 001 -> 007
- 002 -> 007
- 001 -> 008
- 002 -> 008
- 001 -> 009
- 002 -> 009
- 001 -> 010
- 002 -> 010
- 001 -> 011
- 002 -> 011
- 001 -> 012
- 002 -> 012
- 003 -> 013
- 004 -> 013
- 005 -> 013
- 006 -> 013
- 007 -> 013
- 008 -> 013
- 009 -> 013
- 010 -> 013
- 011 -> 013
- 012 -> 013

## Critical Path

001 -> 002 -> 003 -> 013
