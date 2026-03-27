# Task 008: Implement Cross-repo comparison and team health overview

## Category

feature

## Priority

P1

## Wave

wave-3

## Delivery Phase

implementation

## Depends On

- 001
- 002

## Blocks

- 013

## Summary

Design and implement the capability for: Cross-repo comparison and team health overview.

## Problem

The product cannot satisfy its initial scope until Cross-repo comparison and team health overview exists as a reviewable, testable capability.

## Solution

Add a focused module for Cross-repo comparison and team health overview that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/users/types.ts — User, Role, Permission interfaces + Zod schemas
- lib/users/service.ts — User CRUD, role assignment, team management
- lib/users/permissions.ts — RBAC check functions (hasPermission, requireRole)
- app/api/users/route.ts — GET (list) + POST (invite) endpoints
- app/api/users/[id]/route.ts — GET/PUT/DELETE user
- app/api/users/[id]/role/route.ts — PUT change user role
- app/admin/users/page.tsx — User management admin page
- prisma/schema.prisma — User, Role, TeamMember models
- tests/users/service.test.ts — User CRUD tests
- tests/users/permissions.test.ts — RBAC logic tests

## Acceptance Criteria

- [ ] The Cross-repo comparison and team health overview capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for Cross-repo comparison and team health overview are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
