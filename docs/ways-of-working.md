# Ways of Working — depsight

## Git Workflow

1. `main` branch is production
2. Feature branches: `feat/<task-id>-<short-name>`
3. PRs reviewed before merge
4. Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`

## Development

```bash
npm run dev          # Start dev server (port 3000)
npx prisma studio    # Database GUI
npx prisma migrate dev --name <desc>  # New migration
```

## Deployment

```bash
docker compose -f docker-compose.traefik.yml build --no-cache app
docker compose -f docker-compose.traefik.yml up -d
```

## Code Review Checklist

- [ ] TypeScript compiles without errors
- [ ] No `any` types
- [ ] DB mutations use transactions where needed
- [ ] Responsive design (mobile + desktop)
- [ ] DE UI strings
- [ ] Meaningful commit messages
