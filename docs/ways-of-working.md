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

The container does not apply schema changes; the deploy hook in `.relay.yml` (`post_update`) does, by running `prisma/pre-push/advisory-unique-key.sql` and then `prisma db push`. For a manual push use `npm run db:push`, not a bare `prisma db push`: the script runs the same SQL first, which removes duplicate Advisory rows and creates the unique key the push would otherwise refuse. No flag or operator step is needed, see [Configuration](configuration.md#deploying-the-advisory-unique-key).

## Code Review Checklist

- [ ] TypeScript compiles without errors
- [ ] No `any` types
- [ ] DB mutations use transactions where needed
- [ ] Responsive design (mobile + desktop)
- [ ] DE UI strings
- [ ] Meaningful commit messages
