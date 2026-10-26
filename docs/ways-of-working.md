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

The hosted instance is deployed with `docker-compose.traefik.yml`, whose hostnames and external `traefik-public` network belong to that instance; it is not the file to start your own deployment from. A self-hosted instance uses `docker-compose.yml`, see [Self-hosting](configuration.md#self-hosting) and its comparison of the two files ([Which compose file](configuration.md#which-compose-file)).

```bash
docker compose -f docker-compose.traefik.yml build --no-cache app
docker compose -f docker-compose.traefik.yml up -d
```

The container does not apply schema changes; the deploy hook in `.relay.yml` (`post_update`) does, by running the one-shot `migrate` service of `docker-compose.traefik.yml` (`docker compose -f docker-compose.traefik.yml run --rm -T --build migrate`), which runs `prisma/pre-push/advisory-unique-key.sql` and then `prisma db push` on the private database network with the compose file's `POSTGRES_PASSWORD`. The service is built from this repository's `Dockerfile` (stage `migrate`) with the Prisma CLI that `package-lock.json` pins, and `run --build` builds it after the pull, from the cache when nothing changed (a plain `build` skips a profile-scoped service, and a `run` without `--build` would reuse an image from before the pull), so the run itself downloads nothing. For a manual push use `npm run db:push`, not a bare `prisma db push`: the script runs the same SQL first, which removes duplicate Advisory rows and creates the unique key the push would otherwise refuse. No flag or operator step is needed, see [Configuration](configuration.md#deploying-the-advisory-unique-key).

## Code Review Checklist

- [ ] TypeScript compiles without errors
- [ ] No `any` types
- [ ] DB mutations use transactions where needed
- [ ] Responsive design (mobile + desktop)
- [ ] UI strings in both locales (DE and EN, `lib/i18n/translations.ts`)
- [ ] Meaningful commit messages
