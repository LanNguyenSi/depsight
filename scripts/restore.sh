#!/usr/bin/env bash
# Restore a dump written by scripts/backup.sh into the running hosted stack.
#
# Usage: scripts/restore.sh --yes [--no-pre-backup] <dump.sql>
#
# DESTRUCTIVE: the whole `public` schema is dropped and recreated, then the dump is
# loaded into it. Every table, view and sequence that exists now and is not in the
# dump is gone (a table a newer release added, with a foreign key into a table the
# dump also has, included: pg_dump --clean alone cannot drop it and the restore would
# fail), and rows written after the dump are lost. Without --yes the script only says
# what it would do and exits 2; there is no interactive prompt, so a cron job or a
# pasted command cannot restore by accident.
#
# What it does, in order:
#   1. checks the file argument, copies the dump into a private temporary file inside
#      BACKUP_DIR and checks THAT copy (size, "dump complete" marker, no transaction
#      control statements); everything below uses the copy, so a file that is rotated
#      away, truncated or replaced meanwhile cannot change what is loaded,
#   2. checks that the db service is running,
#   3. stops the app service when it is running (the app holds connections that
#      would block the DROPs and write rows while the schema is replaced),
#   4. takes a dump of the CURRENT state with scripts/backup.sh into BACKUP_DIR
#      (rotation skipped), unless --no-pre-backup; a failure ends the run before
#      anything is changed and the app is started again,
#   5. pipes `BEGIN;`, `DROP SCHEMA public CASCADE; CREATE SCHEMA public ...`, the
#      dump and, only when the whole dump was read successfully, `COMMIT;` into psql
#      with ON_ERROR_STOP=1. psql is not given --single-transaction because that
#      commits at end of input: an input that ends early (the copy unreadable) would
#      commit a dropped, empty schema. Without the final COMMIT the session ends in
#      a rollback, so any error or short input leaves the database with its old content,
#   6. runs the migrate service (RESTORE_MIGRATE_SERVICE), so a dump that predates a
#      schema change gets the columns and tables the deployed code expects, exactly
#      as every deploy does (`prisma db push`),
#   7. starts the app again, only after steps 5 and 6 succeeded. After a failure the
#      app stays stopped on purpose: look at the error first.
#
# A pre-restore dump of an (almost) empty database is below backup.sh's size floor and
# fails validation: restore into a fresh database with --no-pre-backup.
#
# Environment (all optional; the compose, db and dump variables are the ones of backup.sh):
#   BACKUP_COMPOSE_FILE      compose file of the stack (default: <repo>/docker-compose.traefik.yml)
#   BACKUP_DB_SERVICE        Postgres service (default: db)
#   BACKUP_DIR               where the pre-restore dump and the private copy of the
#                            dump go (default: <repo>/backups)
#   RESTORE_APP_SERVICE      service stopped during the restore (default: app; empty = leave alone)
#   RESTORE_MIGRATE_SERVICE  one-shot schema service run after the restore (default: migrate;
#                            empty = skip, then run the schema step yourself before the app starts)
#   PG_USER / PG_DB          database user and name (default: depsight / depsight)
#
# Exit codes:
#   0  restored (migrated, app started)
#   1  dump invalid, the app could not be stopped (nothing changed), psql failed or
#      the dump could not be read (nothing committed, database unchanged, app left
#      stopped), or interrupted before psql confirmed the load (check the database:
#      if only this script was stopped, psql may have committed)
#   2  refused: no file, file missing, no --yes, compose file missing, db not running
#   3  the pre-restore dump failed; nothing was changed (use --no-pre-backup to go on)
#   4  the dump is restored, but the migrate step or the app start failed, or the
#      script was interrupted after the restore committed; the app is stopped or not
#      healthy: run the printed command(s) by hand
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.traefik.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
APP_SERVICE="${RESTORE_APP_SERVICE-app}"
MIGRATE_SERVICE="${RESTORE_MIGRATE_SERVICE-migrate}"
PG_USER="${PG_USER:-depsight}"
PG_DB="${PG_DB:-depsight}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"

# The public schema as a fresh PostgreSQL 16 database has it (owner, comment, USAGE
# for everyone), so a restored database matches one created by initdb. The SET keeps
# the dozens of "drop cascades to ..." notices out of the output.
RESET_SQL='SET client_min_messages = warning;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
COMMENT ON SCHEMA public IS '"'"'standard public schema'"'"';
GRANT USAGE ON SCHEMA public TO PUBLIC;'

# Private copy of the dump (created in BACKUP_DIR), removed on every exit path.
tmp=""
cleanup() { [ -z "$tmp" ] || rm -f "$tmp"; }
trap cleanup EXIT

start_hint="docker compose -f $COMPOSE_FILE start $APP_SERVICE"
migrate_hint="docker compose -f $COMPOSE_FILE run --rm -T --build $MIGRATE_SERVICE"
stopped_app=0

# Phase marker, set once the psql pipeline has returned zero, i.e. COMMIT is done.
# A HUP, INT or TERM signal after that exits 4 and says the restore is committed.
# Before it the exit stays 1, but bash runs this trap only after the foreground
# psql pipeline returns: a signal sent to this script alone while psql is loading
# lets psql finish and possibly commit, and is still reported here as a stop
# before the commit was confirmed. Stopping the whole process group (Ctrl-C in the
# terminal) stops psql too, which then rolls back.
committed=0
on_signal() {
  if [ "$committed" -eq 1 ]; then
    echo "restore: interrupted after the restore committed; the database has the content of the dump" >&2
    [ -z "$MIGRATE_SERVICE" ] || echo "restore: the $MIGRATE_SERVICE step did not run; apply the schema with: $migrate_hint" >&2
    [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
    exit 4
  fi
  echo "restore: interrupted before psql confirmed the load; if only this script was stopped, psql may have finished and the database may already hold the dump: check it before assuming it is unchanged" >&2
  exit 1
}
trap on_signal HUP INT TERM

usage="usage: restore.sh --yes [--no-pre-backup] <dump.sql>"
refuse() { echo "restore: $*" >&2; exit 2; }

confirmed=0
pre_backup=1
file=""
for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=1 ;;
    --no-pre-backup) pre_backup=0 ;;
    -*) refuse "unknown option '$arg' ($usage)" ;;
    *)
      [ -z "$file" ] || refuse "more than one file given ($usage)"
      file="$arg"
      ;;
  esac
done

[ -n "$file" ] || refuse "no dump file given ($usage)"
[ -f "$file" ] || refuse "dump file not found: $file"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"

if [ "$confirmed" -ne 1 ]; then
  echo "restore: would replace the content of database '$PG_DB' (compose file $COMPOSE_FILE) with $file." >&2
  refuse "this destroys everything not in the dump, including rows written after it; run again with --yes to proceed"
fi

# Work on a private snapshot: the later steps (stopping the app, the pre-restore dump)
# take time, and the file may be rotated away or truncated in between. The copy lives
# in BACKUP_DIR, the one directory whose free space backup.sh already depends on, and
# is named so that backup.sh's rotation (depsight-*.sql) never matches it.
if [ ! -d "$BACKUP_DIR" ] && ! { mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"; }; then
  echo "restore: could not prepare $BACKUP_DIR for the private copy of the dump" >&2
  exit 1
fi
tmp="$(umask 077 && mktemp "$BACKUP_DIR/restore-dump.XXXXXX")" \
  || { echo "restore: could not create a temporary file in $BACKUP_DIR" >&2; exit 1; }
if ! cp -- "$file" "$tmp"; then
  echo "restore: could not copy $file to $tmp; nothing was changed" >&2
  exit 1
fi

size="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "restore: $file is too small ($size bytes) to be a dump" >&2
  exit 1
fi
if ! grep -qx -- '-- PostgreSQL database dump complete' "$tmp"; then
  echo "restore: $file is missing the completion marker (truncated dump?)" >&2
  exit 1
fi
# The restore runs inside the transaction opened here; a COMMIT or similar line in the
# dump would end it early and make the later error handling a lie. Plain pg_dump output
# has none at the start of a line.
if grep -q -i -E '^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT)[[:space:]]*;' "$tmp"; then
  echo "restore: $file contains transaction control statements; refusing to load it" >&2
  exit 1
fi

DC=(docker compose -f "$COMPOSE_FILE")
running="$("${DC[@]}" ps --status running --services)" \
  || refuse "docker compose could not list the services of $COMPOSE_FILE"
grep -qx "$DB_SERVICE" <<< "$running" \
  || refuse "service '$DB_SERVICE' is not running in $COMPOSE_FILE; start the db first"

echo "restore: compose file $COMPOSE_FILE, database '$PG_DB', dump $file"

if [ -n "$APP_SERVICE" ] && grep -qx "$APP_SERVICE" <<< "$running"; then
  echo "restore: stopping $APP_SERVICE"
  if ! "${DC[@]}" stop "$APP_SERVICE"; then
    echo "restore: could not stop $APP_SERVICE; nothing was changed" >&2
    exit 1
  fi
  stopped_app=1
fi

if [ "$pre_backup" -eq 1 ]; then
  echo "restore: backing up the current state first (scripts/backup.sh)"
  if ! BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DB_SERVICE="$DB_SERVICE" PG_USER="$PG_USER" PG_DB="$PG_DB" \
    BACKUP_SKIP_ROTATION=1 "$SCRIPT_DIR/backup.sh"; then
    echo "restore: the pre-restore backup failed; nothing was changed. Fix it, or pass --no-pre-backup to restore without it" >&2
    if [ "$stopped_app" -eq 1 ]; then
      echo "restore: starting $APP_SERVICE again"
      "${DC[@]}" start "$APP_SERVICE" || echo "restore: could not start $APP_SERVICE; run: $start_hint" >&2
    fi
    exit 3
  fi
fi

echo "restore: restoring $file into database '$PG_DB'"
# COMMIT is sent only when the whole copy was read: if cat fails, psql sees end of
# input inside the open transaction and rolls it back (pipefail turns the failure of
# the left side into the failure of the pipeline).
if ! { printf 'BEGIN;\n%s\n' "$RESET_SQL"; cat "$tmp" && printf 'COMMIT;\n'; } \
  | "${DC[@]}" exec -T "$DB_SERVICE" psql -v ON_ERROR_STOP=1 -q \
    -U "$PG_USER" -d "$PG_DB" > /dev/null; then
  echo "restore: psql failed or the dump could not be read; nothing was committed, the database is unchanged" >&2
  [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
  exit 1
fi
# The pipeline returned zero: COMMIT is done and the restore is committed. A signal
# from here on exits 4 and says so.
committed=1

if [ -n "$MIGRATE_SERVICE" ]; then
  echo "restore: applying the current schema ($MIGRATE_SERVICE)"
  if ! "${DC[@]}" run --rm -T --build "$MIGRATE_SERVICE"; then
    echo "restore: the dump is restored, but the $MIGRATE_SERVICE step (image build or schema push) failed; see the output above (a dump taken from newer code than the deployed code is one example)." >&2
    [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; after fixing it run: $start_hint" >&2
    exit 4
  fi
fi

if [ "$stopped_app" -eq 1 ]; then
  echo "restore: starting $APP_SERVICE"
  if ! "${DC[@]}" start "$APP_SERVICE"; then
    echo "restore: the dump is restored, but $APP_SERVICE did not start; run: $start_hint" >&2
    exit 4
  fi
fi
echo "restore: done"
