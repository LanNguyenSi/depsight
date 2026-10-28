## Summary

<!-- One or two sentences. What changed? -->

## Motivation

<!-- Why this change? Link the issue if applicable. -->

## Test plan

- [ ] `npm run build`
- [ ] `npm test`
- [ ] For Prisma schema changes: `npm run db:push` applies cleanly (no migrations directory; a new unique key over existing rows needs a step in `prisma/pre-push/`, see CONTRIBUTING.md)
- [ ] For Prisma schema changes: the change is additive, or split into an expand and a later contract release, so the previous release still runs on the new schema (a rollback never reverts it); a fresh `make backup` exists before the merge, see [docs/rollback.md](../docs/rollback.md)
- [ ] Manual smoke check: <!-- command or scenario -->

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs, follow-ups, open questions. -->
