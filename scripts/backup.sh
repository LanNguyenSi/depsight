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
# Cron:    17 3 * * * cd /path/to/depsight && scripts/backup.sh >> "$HOME/depsight-backup.log" 2>&1
#          (the log lives under $HOME: /var/log is not writable for the docker-group
#          user that runs the job, and a redirect that cannot open its file means the
#          script never runs at all)
#
# Environment (all optional):
#   BACKUP_COMPOSE_FILE  compose file of the stack (default: <repo>/docker-compose.traefik.yml)
#   BACKUP_DB_SERVICE    compose service that runs Postgres (default: db)
#   BACKUP_DIR           target directory (default: <repo>/backups, mode 700). Inside
#                        the checkout only <repo>/backups is allowed: it is in
#                        .dockerignore, so the dumps (every user's OAuth token in
#                        clear text) never enter a docker build context; any other
#                        directory under the checkout is refused (exit 2)
#   PG_USER / PG_DB      database user and name (default: depsight / depsight)
#   KEEP_FILES           keep at most this many dumps (default: 14)
#   KEEP_DAYS            delete dumps older than this many days (default: 14)
#   BACKUP_SKIP_ROTATION set to a non-empty value to skip the rotation (scripts/restore.sh
#                        does this for its pre-restore dump, so that dump can never age
#                        out the file that is being restored)
#   BACKUP_OFFHOST_HOOK  executable that copies the finished dump off this host;
#                        called with the dump path as its only argument. The dump
#                        holds every user's GitHub OAuth token in clear text:
#                        encrypt it in the hook before it leaves the host.
#
# Exit codes:
#   0  dump written and validated (hook, if set, succeeded; rotation done)
#   1  pg_dump failed or the dump failed validation (nothing published)
#   2  refused before dumping: bad configuration, BACKUP_DIR inside the checkout but
#      outside backups/, compose file missing, or the db service is not running
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
SKIP_ROTATION="${BACKUP_SKIP_ROTATION:-}"

refuse() { echo "backup: $*" >&2; exit 2; }

case "$KEEP_FILES" in ''|*[!0-9]*) refuse "KEEP_FILES must be a positive integer, got '$KEEP_FILES'" ;; esac
case "$KEEP_DAYS" in ''|*[!0-9]*) refuse "KEEP_DAYS must be a positive integer, got '$KEEP_DAYS'" ;; esac
[ "$KEEP_FILES" -ge 1 ] || refuse "KEEP_FILES must be at least 1"
[ "$KEEP_DAYS" -ge 1 ] || refuse "KEEP_DAYS must be at least 1"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"
if [ -n "$OFFHOST_HOOK" ] && { [ ! -f "$OFFHOST_HOOK" ] || [ ! -x "$OFFHOST_HOOK" ]; }; then
  refuse "BACKUP_OFFHOST_HOOK is not an executable file: $OFFHOST_HOOK"
fi

# A dump inside the checkout but outside backups/ would be sent to the docker daemon
# with every build (Dockerfile `COPY . .`); only backups/ is in .dockerignore. Resolve
# through the nearest existing ancestor so symlinks and a not yet created directory
# are judged by where they really are.
case "$BACKUP_DIR" in /*) abs_dir="$BACKUP_DIR" ;; *) abs_dir="$PWD/$BACKUP_DIR" ;; esac
anc="$abs_dir"
while [ ! -d "$anc" ]; do anc="$(dirname "$anc")"; done
missing="${abs_dir#"$anc"}"
case "$missing/" in
  */../*) refuse "BACKUP_DIR $BACKUP_DIR has a '..' in a part that does not exist yet; give a plain path" ;;
esac
phys_dir="$(cd "$anc" && pwd -P)$missing"
phys_repo="$(cd "$REPO_ROOT" && pwd -P)"
case "$phys_dir/" in
  "$phys_repo/backups/"*) ;;
  "$phys_repo/"*) refuse "BACKUP_DIR $BACKUP_DIR is inside the checkout but not backups/; dumps there would enter docker build contexts (only backups/ is in .dockerignore). Use $phys_repo/backups or a directory outside the checkout" ;;
esac

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
# Two runs in the same second (a cron job and a pre-restore dump) must not overwrite
# each other.
if [ -e "$out" ]; then out="$BACKUP_DIR/depsight-$ts-$$.sql"; fi

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
# The whole line, so a data row that merely contains the text is not a marker.
if ! grep -qx -- '-- PostgreSQL database dump complete' "$tmp"; then
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

if [ -n "$SKIP_ROTATION" ]; then
  echo "backup: rotation skipped (BACKUP_SKIP_ROTATION)"
  exit 0
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
