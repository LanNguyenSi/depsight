#!/usr/bin/env bash
# Postgres backup for the hosted depsight stack (docker-compose.traefik.yml).
#
# Writes one plain-SQL pg_dump (--clean --if-exists) per run into BACKUP_DIR as
# depsight-<YYYYMMDD_HHMMSS>.sql. Plain SQL, not the custom format: the dump is
# validated on the host with grep (the db image is the only place pg_restore
# exists), it restores with psql alone (scripts/restore.sh), and a human can read
# or patch it. The dump goes through `docker compose exec -T db pg_dump`, so no
# Postgres client is needed on the host and the db stays on its private network.
#
# Safe against partial files: the dump is written to a hidden temp name, checked
# (non-trivial size and pg_dump's "dump complete" marker) and only then renamed,
# so a failed run never leaves a truncated or empty depsight-*.sql behind.
#
# Usage:   scripts/backup.sh
# Cron:    17 3 * * * /path/to/depsight/scripts/backup.sh >> /var/log/depsight-backup.log 2>&1
#
# Environment (all optional):
#   BACKUP_COMPOSE_FILE  compose file of the stack (default: <repo>/docker-compose.traefik.yml)
#   BACKUP_DB_SERVICE    compose service that runs Postgres (default: db)
#   BACKUP_DIR           target directory (default: <repo>/backups, mode 700)
#   PG_USER / PG_DB      database user and name (default: depsight / depsight)
#   KEEP_FILES           keep at most this many dumps (default: 14)
#   KEEP_DAYS            delete dumps older than this many days (default: 14)
#   BACKUP_OFFHOST_HOOK  executable that copies the finished dump off this host;
#                        called with the dump path as its only argument. The dump
#                        holds every user's GitHub OAuth token in clear text:
#                        encrypt it in the hook before it leaves the host.
#
# Exit codes:
#   0  dump written and validated (hook, if set, succeeded; rotation done)
#   1  pg_dump failed or the dump failed validation (nothing published)
#   2  refused before dumping: bad configuration, compose file missing, or the
#      db service is not running
#   3  dump is published and valid, but the off-host hook failed (rotation is
#      skipped so a broken off-host copy never pushes older dumps out)
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.traefik.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
PG_USER="${PG_USER:-depsight}"
PG_DB="${PG_DB:-depsight}"
KEEP_FILES="${KEEP_FILES:-14}"
KEEP_DAYS="${KEEP_DAYS:-14}"
OFFHOST_HOOK="${BACKUP_OFFHOST_HOOK:-}"

refuse() { echo "backup: $*" >&2; exit 2; }

case "$KEEP_FILES" in ''|*[!0-9]*) refuse "KEEP_FILES must be a positive integer, got '$KEEP_FILES'" ;; esac
case "$KEEP_DAYS" in ''|*[!0-9]*) refuse "KEEP_DAYS must be a positive integer, got '$KEEP_DAYS'" ;; esac
[ "$KEEP_FILES" -ge 1 ] || refuse "KEEP_FILES must be at least 1"
[ "$KEEP_DAYS" -ge 1 ] || refuse "KEEP_DAYS must be at least 1"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"
if [ -n "$OFFHOST_HOOK" ] && { [ ! -f "$OFFHOST_HOOK" ] || [ ! -x "$OFFHOST_HOOK" ]; }; then
  refuse "BACKUP_OFFHOST_HOOK is not an executable file: $OFFHOST_HOOK"
fi

DC=(docker compose -f "$COMPOSE_FILE")

# The db service must be running: a stack that is down, or another stack than the
# one in COMPOSE_FILE, has no such container, and a cron job must not report
# success for it.
running="$("${DC[@]}" ps --status running --services)" \
  || refuse "docker compose could not list the services of $COMPOSE_FILE"
grep -qx "$DB_SERVICE" <<< "$running" \
  || refuse "service '$DB_SERVICE' is not running in $COMPOSE_FILE; start the production stack first"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# Reap temp files left behind by a SIGKILL'd run or a reboot mid-dump.
find "$BACKUP_DIR" -maxdepth 1 -name '.depsight-*.sql.tmp' -mtime +1 -delete
tmp="$BACKUP_DIR/.depsight-$ts.$$.sql.tmp"
out="$BACKUP_DIR/depsight-$ts.sql"

cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

"${DC[@]}" exec -T "$DB_SERVICE" pg_dump --clean --if-exists -U "$PG_USER" "$PG_DB" > "$tmp" \
  || { echo "backup: pg_dump failed, nothing published" >&2; exit 1; }

# Validate before publishing: non-trivial size and pg_dump's completion marker.
size="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "backup: dump too small ($size bytes), refusing to keep it" >&2
  exit 1
fi
# Whole file, not a tail window: pg_dump 16.10+ appends a \unrestrict block after
# the marker, which pushes it off a fixed-size tail.
if ! grep -q "PostgreSQL database dump complete" "$tmp"; then
  echo "backup: dump is missing the completion marker, refusing to keep it" >&2
  exit 1
fi

mv "$tmp" "$out"
echo "backup: wrote $out ($size bytes)"

if [ -n "$OFFHOST_HOOK" ]; then
  if "$OFFHOST_HOOK" "$out"; then
    echo "backup: off-host hook done"
  else
    echo "backup: off-host hook failed; the local dump is kept, rotation skipped" >&2
    exit 3
  fi
fi

# Rotation: keep at most KEEP_FILES dumps and nothing older than KEEP_DAYS days.
# Names are machine-generated (depsight-<timestamp>.sql), so ls -t is safe here.
n=0
# shellcheck disable=SC2012
while IFS= read -r f; do
  n=$((n + 1))
  if [ "$n" -gt "$KEEP_FILES" ]; then rm -f "$f"; fi
done < <(ls -t "$BACKUP_DIR"/depsight-*.sql 2>/dev/null || true)
# The dump just written is never aged out, even with a skewed clock.
find "$BACKUP_DIR" -maxdepth 1 -name 'depsight-*.sql' ! -path "$out" -mtime +"$KEEP_DAYS" -delete
kept="$(find "$BACKUP_DIR" -maxdepth 1 -name 'depsight-*.sql' | wc -l | tr -d ' ')"
echo "backup: rotation done ($kept dumps kept)"
