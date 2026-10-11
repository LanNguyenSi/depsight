## Summary

<!-- One or two sentences. What changed? -->

## Motivation

<!-- Why this change? Link the issue if applicable. -->

## Test plan

- [ ] `npm run build`
- [ ] `npm test`
- [ ] For Prisma schema changes: `npm run db:push` applies cleanly (no migrations directory; a new unique key over existing rows needs a step in `prisma/pre-push/`, see CONTRIBUTING.md)
- [ ] Manual smoke check: <!-- command or scenario -->

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs, follow-ups, open questions. -->
