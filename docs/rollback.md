# Rollback and the database schema

A relay rollback reverts the code and the image. It never reverts the database schema. This page says why, which `prisma/schema.prisma` changes survive a rollback, and what to do when one does not.

## Why a rollback leaves the schema alone

The deploy hook in `.relay.yml` applies the schema in `post_update`: it runs `docker compose -f docker-compose.traefik.yml run --rm -T --build migrate`. The `migrate` service runs `prisma/pre-push/advisory-unique-key.sql` and then `prisma db push` (see `docker-compose.traefik.yml`). The repository has no `prisma/migrations` directory (see [Architecture](architecture.md)), so there is no migration history and no down step to run. `.relay.yml` also sets `rollback: true`. When the relay rolls back, the new schema is already committed; the old code and image come back on top of it.

So after a rollback the instance runs the old release against the new schema. That state is only healthy when the old code works with the new schema.

## Expand and contract for `prisma/schema.prisma`

Make every schema change safe for the release before it, and remove things only in a later release.

Safe across a rollback (additive):

- a new table;
- a new optional column (`String?`) or a column with a `@default`;
- a new index that is not unique.

Not safe across a rollback:

- a dropped or renamed column or table (old code queries what no longer exists; `prisma db push` also refuses a drop that loses data unless `--accept-data-loss` is passed, and the `migrate` command carries no such flag);
- a new `NOT NULL` column without a default (old code inserts rows without it);
- a new unique key or unique index that old code can violate (old code fails with `P2002`);
- a removed enum value, and a new enum value once rows hold it (old code cannot read those rows).

For a change in the second list, split it over releases: first ship the additive step (new column optional, old column kept) together with code that works against both shapes, then in a later release tighten or drop. A rollback of the later release then lands on a schema the earlier code still understands.

## Runbook: a rollback after a non-additive schema change

Symptoms: the relay rolled back (or you rolled back by hand), and the old release fails against the new schema, for example with `P2002` or with a missing column.

1. **Decide: forward fix or restore.** Prefer the forward fix. Choose restore only when the new schema damaged data or no quick code fix exists, because a restore loses every row written after the dump.
2. **Forward fix.** Fix the code so it works with the new schema, merge it, and deploy as usual (see [Deployment](ways-of-working.md#deployment)). Do not simply revert a commit that added a column or table: the revert makes `prisma db push` drop it, which is a data-loss push that the `migrate` command refuses, so the deploy stops. Revert the code that needs the new shape, and leave the schema line in place until a deliberate contract release.
3. **Restore from a backup.** Take a dump of the current state first if you want to keep it (`scripts/restore.sh` does this itself unless you pass `--no-pre-backup`). Check out the release you want to run, because the `migrate` step builds from the working tree. Then run `scripts/restore.sh --yes <dump.sql>` with the dump taken before the deploy (`ls -t backups/depsight-*.sql | head -3`). What it does, its exit codes and the limits of a dump are in the Restore paragraph of [Backup and restore](configuration.md#backup-and-restore); they are not repeated here.
4. **Check.** `curl -fsS https://depsight.opentriologue.ai/api/health` answers, and a CVE scan of a repository completes.

### Worked example: the Advisory unique key

`Advisory` carries a unique key over `(scanId, ghsaId, packageName)`, created by `prisma/pre-push/advisory-unique-key.sql` during `post_update`. The key stays in place after a rollback. Releases from before the key do not collapse repeated Dependabot alerts, so their CVE scans of repositories with repeated alerts fail with `P2002` until the next forward deploy.

- Forward fix: deploy a release that carries the key (the normal path).
- Intentional downgrade: drop the index first, with the command the stack's other `psql` recipes use:

  ```bash
  docker compose -f docker-compose.traefik.yml exec -T db psql -v ON_ERROR_STOP=1 -U depsight -d depsight \
    -c 'DROP INDEX "Advisory_scanId_ghsaId_packageName_key";'
  ```

  The next deploy of a release with the key recreates it through the same SQL step. Background in [Deploying the Advisory unique key](configuration.md#deploying-the-advisory-unique-key).

## Checklist for a pull request that touches `prisma/schema.prisma`

- The change is additive, or it is split into an expand release and a later contract release.
- The previous release still runs against the new schema (old code, new schema), or the pull request says why it cannot.
- A fresh dump exists before the merge: `make backup` (`scripts/backup.sh`).
- A new unique key over existing rows has its step in `prisma/pre-push/`.
