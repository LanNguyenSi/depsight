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

The hosted instance normally deploys through the relay hook in `.relay.yml`, which builds, runs the schema step (`post_update`), gates on `/api/health` and rolls back when the gate fails (`.relay.yml` sets `rollback: true`). To deploy by hand when the relay is not used, follow the same steps in the order the relay uses them:

1. Build the app image: `docker compose -f docker-compose.traefik.yml build --no-cache app`
2. Apply schema changes with the one-shot `migrate` service: `docker compose -f docker-compose.traefik.yml run --rm -T --build migrate`
3. Start the stack: `docker compose -f docker-compose.traefik.yml up -d`
4. Check health against `/api/health` (the target the relay gates on): `docker compose -f docker-compose.traefik.yml exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health").then((r) => process.exit(r.ok ? 0 : 1))'`

The manual path has no automatic rollback (only the relay does, via `rollback: true`): to go back, check out the previous commit and repeat the steps, because step 1 rebuilds the app image under the same name and no earlier image is kept for step 3 to start.

The `migrate` service (step 2) does not just run `prisma db push`: it first runs `prisma/pre-push/advisory-unique-key.sql`, which removes duplicate Advisory rows and creates the unique key a bare push would otherwise refuse, and then pushes, on the private database network with the compose file's `POSTGRES_PASSWORD`. It is built from this repository's `Dockerfile` (stage `migrate`) with the Prisma CLI that `package-lock.json` pins, and `run --build` builds it after the pull, from the cache when nothing changed (a plain `build` skips a profile-scoped service, and a `run` without `--build` would reuse an image from before the pull), so the run itself downloads nothing. For a manual push outside this sequence use `npm run db:push`, not a bare `prisma db push`: it runs the same SQL first. No flag or operator step is needed, see [Configuration](configuration.md#deploying-the-advisory-unique-key).

## Code Review Checklist

- [ ] TypeScript compiles without errors
- [ ] No `any` types
- [ ] DB mutations use transactions where needed
- [ ] Responsive design (mobile + desktop)
- [ ] UI strings in both locales (DE and EN, `lib/i18n/translations.ts`)
- [ ] Meaningful commit messages
