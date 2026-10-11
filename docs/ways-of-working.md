# Ways of Working — depsight

## Git Workflow

1. `master` branch is production
2. Feature branches: `feat/<short-name>` or `fix/<short-name>` (see [CONTRIBUTING.md](../CONTRIBUTING.md))
3. PRs reviewed before merge
4. Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`

## Development

```bash
npm run dev          # Start dev server (port 3000)
npx prisma studio    # Database GUI
npm run db:push      # Push schema changes (no migrations directory)
```

## Deployment

The hosted instance is deployed with `docker-compose.traefik.yml`, whose hostnames and external `traefik-public` network belong to that setup; for your own deployment see [Self-hosting](configuration.md#self-hosting).

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
- [ ] UI strings in both locales (DE and EN, `lib/i18n/translations.ts`)
- [ ] Meaningful commit messages
