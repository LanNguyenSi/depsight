# Ways of Working — depsight

## Git Workflow

1. `master` branch is production
2. Feature branches: `feat/<task-id>-<short-name>`
3. PRs reviewed before merge
4. Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`

## Development

```bash
npm run dev          # Start dev server (port 3000)
npx prisma studio    # Database GUI
npm run db:push      # Push schema changes (no migrations directory)
```

## Deployment

```bash
docker compose -f docker-compose.traefik.yml build --no-cache app
docker compose -f docker-compose.traefik.yml up -d
```

The container does not apply schema changes. When a release changes `prisma/schema.prisma`, run `npm run db:push` against the production database from a checkout of the deployed commit (not a bare `prisma db push`: the script first removes duplicate Advisory rows that would block the new unique key). The release that introduced that key needs `npm run db:push -- --accept-data-loss` once, see [Configuration](configuration.md#deploying-the-advisory-unique-key).

## Code Review Checklist

- [ ] TypeScript compiles without errors
- [ ] No `any` types
- [ ] DB mutations use transactions where needed
- [ ] Responsive design (mobile + desktop)
- [ ] DE UI strings
- [ ] Meaningful commit messages
