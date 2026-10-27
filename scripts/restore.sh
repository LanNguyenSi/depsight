#!/usr/bin/env bash
# Restore a dump written by scripts/backup.sh into the running hosted stack.
#
# Usage: scripts/restore.sh --yes <dump.sql>
#
# DESTRUCTIVE: the dump carries DROP ... IF EXISTS statements (pg_dump --clean
# --if-exists), so every table it describes is replaced by the dump's content.
# Rows written after the dump are lost. Without --yes the script only says what it
# would do and exits 2; there is no interactive prompt, so a cron job or a pasted
# command cannot restore by accident.
#
# What it does, in order:
#   1. checks the file argument and the dump (size and "dump complete" marker),
#   2. checks that the db service is running,
#   3. stops the app service when it is running (the app holds connections that
#      would block the DROPs and write rows while the tables are replaced),
#   4. pipes the dump into psql with ON_ERROR_STOP=1 and --single-transaction:
#      any error rolls everything back and the database keeps its old content,
#   5. starts the app again, only after a successful restore. After a failed
#      restore the app stays stopped on purpose: look at the error first.
#
# Environment (all optional, same names as backup.sh):
#   BACKUP_COMPOSE_FILE  compose file of the stack (default: <repo>/docker-compose.traefik.yml)
#   BACKUP_DB_SERVICE    Postgres service (default: db)
#   RESTORE_APP_SERVICE  service stopped during the restore (default: app; empty = leave alone)
#   PG_USER / PG_DB      database user and name (default: depsight / depsight)
#
# Exit codes: 0 restored; 1 dump invalid or psql failed; 2 refused (no file, file
# missing, no --yes, compose file missing, db service not running).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.traefik.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
APP_SERVICE="${RESTORE_APP_SERVICE-app}"
PG_USER="${PG_USER:-depsight}"
PG_DB="${PG_DB:-depsight}"

refuse() { echo "restore: $*" >&2; exit 2; }

confirmed=0
file=""
for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=1 ;;
    -*) refuse "unknown option '$arg' (usage: restore.sh --yes <dump.sql>)" ;;
    *)
      [ -z "$file" ] || refuse "more than one file given (usage: restore.sh --yes <dump.sql>)"
      file="$arg"
      ;;
  esac
done

[ -n "$file" ] || refuse "no dump file given (usage: restore.sh --yes <dump.sql>)"
[ -f "$file" ] || refuse "dump file not found: $file"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"

if [ "$confirmed" -ne 1 ]; then
  echo "restore: would replace the content of database '$PG_DB' with $file." >&2
  refuse "this destroys rows written after the dump; run again with --yes to proceed"
fi

size="$(wc -c < "$file" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "restore: $file is too small ($size bytes) to be a dump" >&2
  exit 1
fi
if ! grep -q "PostgreSQL database dump complete" "$file"; then
  echo "restore: $file is missing the completion marker (truncated dump?)" >&2
  exit 1
fi

DC=(docker compose -f "$COMPOSE_FILE")
running="$("${DC[@]}" ps --status running --services)" \
  || refuse "docker compose could not list the services of $COMPOSE_FILE"
grep -qx "$DB_SERVICE" <<< "$running" \
  || refuse "service '$DB_SERVICE' is not running in $COMPOSE_FILE; start the db first"

stopped_app=0
if [ -n "$APP_SERVICE" ] && grep -qx "$APP_SERVICE" <<< "$running"; then
  echo "restore: stopping $APP_SERVICE"
  "${DC[@]}" stop "$APP_SERVICE"
  stopped_app=1
fi

echo "restore: restoring $file into database '$PG_DB'"
if ! "${DC[@]}" exec -T "$DB_SERVICE" psql -v ON_ERROR_STOP=1 --single-transaction -q \
  -U "$PG_USER" -d "$PG_DB" < "$file" > /dev/null; then
  echo "restore: psql failed; the transaction was rolled back, the database is unchanged" >&2
  [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: docker compose -f $COMPOSE_FILE start $APP_SERVICE" >&2
  exit 1
fi

if [ "$stopped_app" -eq 1 ]; then
  echo "restore: starting $APP_SERVICE"
  "${DC[@]}" start "$APP_SERVICE"
fi
echo "restore: done"
