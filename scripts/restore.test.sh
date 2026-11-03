#!/usr/bin/env bash
# Test driver for scripts/restore.sh with a fake `docker` on PATH.
#   bash scripts/restore.test.sh
# The fake answers every compose call restore.sh makes and records it; it does not run
# SQL. What psql does with a dump (restricted mode, the transaction check, the scratch
# database) is tested against a real Postgres by scripts/restore-drill.sh.
set -euo pipefail
# Job control: the driver runs restore.sh as a background job (to know its PID), and
# without -m an async job ignores SIGINT, so the INT trap of restore.sh could not be
# tested.
set -m

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTORE_SCRIPT="$SCRIPT_DIR/restore.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
export HOME="$WORKDIR/home"
mkdir -p "$HOME"

export FAKE_DOCKER_LOG="$WORKDIR/docker.log"
# what psql read: the load into the real database, and the load into the scratch database
export FAKE_PSQL_STDIN="$WORKDIR/psql_stdin"
export FAKE_SCRATCH_STDIN="$WORKDIR/scratch_stdin"
export FAKE_SCRIPT_PID="$WORKDIR/script.pid"
# restore.sh keeps its private copy of the dump in BACKUP_DIR; TMPDIR is exported so
# that a copy landing there instead is visible to the tests (no_tmp_left, case (v))
TMPD="$WORKDIR/tmp"
mkdir -p "$TMPD"
COMPOSE_FILE="$WORKDIR/compose.yml"
: > "$COMPOSE_FILE"
BACKUPS="$WORKDIR/backups"

fail_count=0
pass_count=0
pass() { pass_count=$((pass_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); echo "FAIL: $1"; }

DUMP="$WORKDIR/good.sql"
{
  printf -- '-- PostgreSQL database dump\n'
  for i in $(seq 1 50); do printf -- 'INSERT INTO t VALUES (%d);\n' "$i"; done
  printf -- '-- PostgreSQL database dump complete\n'
} > "$DUMP"
export FAKE_PG_DUMP_SRC="$DUMP"

# The fake docker. A psql load (stdin, no -c) stores what it read and, like real psql at
# the end of a good load, prints the argument of the last \echo line (the sentinel).
cat > "$FAKE_BIN/docker" <<'EOF2'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
# FAKE_KILL_ON: a glob over the call; signal restore.sh during that call, to exercise its
# traps. The driver writes restore.sh's PID to $FAKE_SCRIPT_PID before it can call docker.
if [ -n "${FAKE_KILL_ON:-}" ]; then
  # shellcheck disable=SC2254
  case "$*" in
    $FAKE_KILL_ON) if [ -s "$FAKE_SCRIPT_PID" ]; then kill -s "${FAKE_KILL_SIGNAL:-TERM}" "$(cat "$FAKE_SCRIPT_PID")" 2> /dev/null; fi ;;
  esac
fi
sentinel() { [ "$1" = 1 ] || sed -n 's/^\\echo //p' "$2" | tail -n 1; }
case "$*" in
  *" ps "*) [ "${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' ${FAKE_RUNNING:-app db}; exit 0 ;;
  *" exec "*pg_dump*)
    [ "${FAKE_PGDUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: fatal error" >&2; exit 1; }
    cat "$FAKE_PG_DUMP_SRC"; exit 0 ;;
  *" exec "*"psql --version"*)
    [ "${FAKE_VERSION_FAIL:-0}" = 1 ] && { echo "exec failed" >&2; exit 1; }
    printf '%s\n' "${FAKE_PSQL_VERSION-psql (PostgreSQL) 16.15}"; exit 0 ;;
  *" exec "*psql*" -c CREATE DATABASE "*)
    [ "${FAKE_CREATEDB_FAIL:-0}" = 1 ] && { echo "ERROR:  permission denied to create database" >&2; exit 1; }
    exit 0 ;;
  *" exec "*psql*" -c DROP DATABASE "*)
    [ "${FAKE_DROPDB_FAIL:-0}" = 1 ] && { echo "${FAKE_DROPDB_ERR:-ERROR:  database is being accessed by other users}" >&2; exit 1; }
    exit 0 ;;
  *" exec -T db rm -f -- /tmp/restore-"*)
    [ "${FAKE_RM_FAIL:-0}" = 1 ] && exit 1; exit 0 ;;
  *" exec "*psql*" -d restore_scratch_"*)
    cat > "$FAKE_SCRATCH_STDIN"
    [ "${FAKE_SCRATCH_FAIL:-0}" = 1 ] && { echo "ERROR:  scratch load failed" >&2; exit 3; }
    sentinel "${FAKE_SCRATCH_NO_SENTINEL:-0}" "$FAKE_SCRATCH_STDIN"; exit 0 ;;
  *" exec "*psql*)
    cat > "$FAKE_PSQL_STDIN"
    [ "${FAKE_PSQL_FAIL:-0}" = 1 ] && { echo "psql: ERROR" >&2; exit 3; }
    sentinel "${FAKE_PSQL_NO_SENTINEL:-0}" "$FAKE_PSQL_STDIN"; exit 0 ;;
  *" stop "*)
    # FAKE_STOP_RM: files (glob allowed) that disappear while the app is being stopped
    # shellcheck disable=SC2086
    [ -z "${FAKE_STOP_RM:-}" ] || rm -f $FAKE_STOP_RM
    [ "${FAKE_STOP_FAIL:-0}" = 1 ] && { echo "stop: error" >&2; exit 5; }; exit 0 ;;
  *" start "*) [ "${FAKE_START_FAIL:-0}" = 1 ] && { echo "start: error" >&2; exit 5; }; exit 0 ;;
  *" run "*) [ "${FAKE_MIGRATE_FAIL:-0}" = 1 ] && { echo "migrate: error" >&2; exit 5; }; exit 0 ;;
  *) echo "fake docker: unexpected call: $*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# FAKE_CP_FAIL=1 makes the copy of the dump into BACKUP_DIR fail without touching the
# source file (a copy target that cannot be written), whatever user the tests run as.
cat > "$FAKE_BIN/cp" <<'EOF3'
#!/usr/bin/env bash
[ "${FAKE_CP_FAIL:-0}" = 1 ] && exit 1
exec /bin/cp "$@"
EOF3
chmod +x "$FAKE_BIN/cp"

# run_restore [VAR=value ...] -- args...; sets rc, out_text. restore.sh runs as a
# background job so its PID is known to the fake docker (FAKE_SCRIPT_PID) before it
# can make a killable call; the wait maps it back to rc.
run_restore() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN" "$FAKE_SCRATCH_STDIN" "$FAKE_SCRIPT_PID"; rm -rf "$BACKUPS"
  rc=0
  env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" ${envs[@]+"${envs[@]}"} "$RESTORE_SCRIPT" "$@" \
    > "$WORKDIR/out" 2>&1 &
  pid="$!"
  printf '%s' "$pid" > "$FAKE_SCRIPT_PID"
  wait "$pid" || rc=$?
  out_text="$(cat "$WORKDIR/out")"
}
no_db_calls() { ! grep -q -E ' (exec|stop|start|run) ' "$FAKE_DOCKER_LOG"; }
# no load, no stop, no pre-restore dump, no migrate, no start: the database and the app
# are untouched (the version check, CREATE and DROP of the scratch database may have run)
no_real_changes() {
  ! grep -q -E ' (stop|start|run) | pg_dump |-U depsight -d depsight$' "$FAKE_DOCKER_LOG" && [ ! -e "$FAKE_PSQL_STDIN" ]
}
line_of() { grep -n -- "$1" "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true; }
count_dumps() { find "$BACKUPS" -maxdepth 1 -name 'depsight-*.sql' 2>/dev/null | wc -l | tr -d ' '; }
# the scratch database the run used (from its CREATE call), and whether it was dropped
scratch_of() { grep -o -E 'CREATE DATABASE "restore_scratch_[0-9a-f]+"' "$FAKE_DOCKER_LOG" | head -1 | sed 's/.*"\(.*\)"/\1/' || true; }
scratch_dropped() {
  local s; s="$(scratch_of)"
  [ -n "$s" ] && grep -q -F -- "-c DROP DATABASE IF EXISTS \"$s\" WITH (FORCE)" "$FAKE_DOCKER_LOG"
}
# wrapped_ok <psql stdin> <body> [<COPY lines>]: the stdin psql saw is the two SET lines,
# BEGIN, the txid capture, \o <tags file>, \restrict <key>, the schema reset, the body byte
# for byte, \unrestrict <same key>, ANALYZE of pg_am, the transaction check, \o, the count
# of the tags file (then removed), the COPY count check against <COPY lines> (default 0),
# COMMIT and the \echo of the sentinel, nothing else. The body must end in a newline.
wrapped_ok() {
  local f="$1" body="$2" copies="${3:-0}" n k t
  [ -s "$f" ] || return 1
  n="$(wc -l < "$body" | tr -d ' ')"
  [ "$(sed -n 1p "$f")" = "SET standard_conforming_strings = on;" ] || return 1
  [ "$(sed -n 2p "$f")" = "SET client_encoding = 'UTF8';" ] || return 1
  [ "$(sed -n 3p "$f")" = "BEGIN;" ] || return 1
  [ "$(sed -n 4p "$f")" = 'SELECT pg_catalog.txid_current() AS restore_t0 \gset' ] || return 1
  [[ "$(sed -n 5p "$f")" =~ ^\\o\ (/tmp/restore-[0-9a-f]{16}\.tags)$ ]] || return 1
  t="${BASH_REMATCH[1]}"
  [[ "$(sed -n 6p "$f")" =~ ^\\restrict\ ([0-9a-f]{32})$ ]] || return 1
  k="${BASH_REMATCH[1]}"
  [ "$(sed -n 7p "$f")" = "SET client_min_messages = warning;" ] \
    && [ "$(sed -n 8p "$f")" = "DROP SCHEMA public CASCADE;" ] \
    && [ "$(sed -n 9p "$f")" = "CREATE SCHEMA public AUTHORIZATION pg_database_owner;" ] \
    && [ "$(sed -n 10p "$f")" = "COMMENT ON SCHEMA public IS 'standard public schema';" ] \
    && [ "$(sed -n 11p "$f")" = "GRANT USAGE ON SCHEMA public TO PUBLIC;" ] || return 1
  sed -n "12,$((11 + n))p" "$f" | cmp -s - "$body" || return 1
  [ "$(sed -n "$((12 + n))p" "$f")" = "\\unrestrict $k" ] || return 1
  [ "$(sed -n "$((13 + n))p" "$f")" = "ANALYZE pg_catalog.pg_am;" ] || return 1
  case "$(sed -n "$((14 + n))p" "$f")" in
    "SELECT pg_catalog.int4("*" FROM (SELECT pg_catalog.int4(pg_catalog.txid_current() OPERATOR(pg_catalog.<>) :restore_t0) AS n) AS restore_check;") ;;
    *) return 1 ;;
  esac
  [ "$(sed -n "$((15 + n))p" "$f")" = '\o' ] || return 1
  [ "$(sed -n "$((16 + n))p" "$f")" = "\\set restore_copies \`LC_ALL=C grep -c -x -E 'COPY [0-9]+' $t; rm -f $t\`" ] || return 1
  case "$(sed -n "$((17 + n))p" "$f")" in
    "SELECT pg_catalog.int4("*"the dump has $copies lines of the form COPY"*" FROM (SELECT pg_catalog.int4(:'restore_copies' OPERATOR(pg_catalog.<>) '$copies') AS n) AS restore_check;") ;;
    *) return 1 ;;
  esac
  [ "$(sed -n "$((18 + n))p" "$f")" = "COMMIT;" ] || return 1
  [[ "$(sed -n "$((19 + n))p" "$f")" =~ ^\\echo\ restore:\ committed\ [0-9a-f]{32}$ ]] || return 1
  [ "$(wc -l < "$f" | tr -d ' ')" = "$((19 + n))" ]
}
# the real load and the scratch load read the same bytes
same_loads() { [ -s "$FAKE_SCRATCH_STDIN" ] && cmp -s "$FAKE_SCRATCH_STDIN" "$FAKE_PSQL_STDIN"; }
stdin_is_reset_plus_dump() { wrapped_ok "$FAKE_PSQL_STDIN" "$DUMP" && same_loads; }
no_tmp_left() {
  [ -z "$(find "$TMPD" -mindepth 1 2>/dev/null)" ] \
    && [ -z "$(find "$BACKUPS" -maxdepth 1 -name 'restore-dump.*' 2>/dev/null)" ]
}

# (a) success: version check, scratch database created, loaded and dropped, then stop app,
# pre-restore dump, reset + dump in one transaction, migrate, start app, in that order
{
  run_restore -- --yes "$DUMP"
  l_ver="$(line_of ' psql --version')"; l_create="$(line_of '-c CREATE DATABASE "restore_scratch_')"
  l_scratch="$(line_of '-d restore_scratch_[0-9a-f]*$')"; l_drop="$(line_of '-c DROP DATABASE IF EXISTS "restore_scratch_')"
  l_stop="$(line_of ' stop app')"; l_dump="$(line_of ' pg_dump ')"; l_psql="$(line_of 'psql -X -v ON_ERROR_STOP=1 -U depsight -d depsight$')"
  l_mig="$(line_of ' run --rm -T --build migrate')"; l_start="$(line_of ' start app')"
  order="$l_ver,$l_create,$l_scratch,$l_drop,$l_stop,$l_dump,$l_psql,$l_mig,$l_start"
  if [ "$rc" -eq 0 ] && stdin_is_reset_plus_dump \
    && grep -q "exec -T db psql -X -v ON_ERROR_STOP=1 -U depsight -d depsight$" "$FAKE_DOCKER_LOG" \
    && ! grep -q -- "--single-transaction" "$FAKE_DOCKER_LOG" && no_tmp_left && scratch_dropped \
    && [ -n "$l_ver" ] && [ "$l_ver" -lt "$l_create" ] && [ "$l_create" -lt "$l_scratch" ] && [ "$l_scratch" -lt "$l_drop" ] \
    && [ "$l_drop" -lt "$l_stop" ] && [ "$l_stop" -lt "$l_dump" ] && [ "$l_dump" -lt "$l_psql" ] && [ "$l_psql" -lt "$l_mig" ] && [ "$l_mig" -lt "$l_start" ] \
    && [ "$(count_dumps)" = 1 ]; then
    pass "(a) success: version check, scratch load and drop, stop app, pre-backup, reset + dump, migrate, start app, in that order"
  else
    fail "(a) success: rc=$rc order=$order dumps=$(count_dumps) out=$out_text"
  fi
}

# (a2) --no-pre-backup: no pg_dump call, no dump in BACKUP_DIR (the directory itself
# exists: the private copy of the dump lives there and is removed on exit)
{
  run_restore -- --yes --no-pre-backup "$DUMP"
  if [ "$rc" -eq 0 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG" && [ "$(count_dumps)" = 0 ] && no_tmp_left \
    && stdin_is_reset_plus_dump; then
    pass "(a2) --no-pre-backup skips the pre-restore dump"
  else
    fail "(a2) no pre-backup: rc=$rc dumps=$(count_dumps)"
  fi
}

# (b) flag order does not matter
{
  run_restore -- "$DUMP" --yes
  if [ "$rc" -eq 0 ] && stdin_is_reset_plus_dump; then pass "(b) --yes after the file works"; else fail "(b) flag order: rc=$rc"; fi
}

# (c) no confirmation -> exit 2, nothing touched
{
  run_restore -- "$DUMP"
  if [ "$rc" -eq 2 ] && no_db_calls && [ ! -e "$FAKE_PSQL_STDIN" ] && grep -q -- "--yes" <<< "$out_text" && grep -q -- "$COMPOSE_FILE" <<< "$out_text"; then
    pass "(c) without --yes: refused, names the compose file, database untouched"
  else
    fail "(c) no confirmation: rc=$rc"
  fi
}

# (d) no file argument (with and without --yes) -> exit 2
{
  run_restore -- ; r1=$rc; n1=0; no_db_calls || n1=1
  run_restore -- --yes; r2=$rc; n2=0; no_db_calls || n2=1
  if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$n1" = 0 ] && [ "$n2" = 0 ]; then
    pass "(d) no file argument -> exit 2"
  else
    fail "(d) no file: $r1 $r2 $n1 $n2"
  fi
}

# (e) missing file -> exit 2
{
  run_restore -- --yes "$WORKDIR/nope.sql"
  if [ "$rc" -eq 2 ] && no_db_calls && grep -q "not found" <<< "$out_text"; then pass "(e) missing file -> exit 2"; else fail "(e) missing file: rc=$rc"; fi
}

# (f) unknown option and two files -> exit 2
{
  run_restore -- --yes --force "$DUMP"; r1=$rc
  run_restore -- --yes "$DUMP" "$DUMP"; r2=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ]; then pass "(f) unknown option / two files -> exit 2"; else fail "(f) args: $r1 $r2"; fi
}

# (g) invalid dumps: tiny, big without marker -> exit 1, database and app untouched
{
  printf 'x\n' > "$WORKDIR/tiny.sql"
  { printf -- '-- PostgreSQL database dump\n'; for i in $(seq 1 80); do printf -- 'INSERT INTO t VALUES (%d);\n' "$i"; done; } > "$WORKDIR/nomarker.sql"
  run_restore -- --yes "$WORKDIR/tiny.sql"; r1=$rc; n1=0; no_db_calls || n1=1
  run_restore -- --yes "$WORKDIR/nomarker.sql"; r2=$rc; n2=0; no_db_calls || n2=1
  if [ "$r1" = 1 ] && [ "$r2" = 1 ] && [ "$n1" = 0 ] && [ "$n2" = 0 ]; then
    pass "(g) invalid dump -> exit 1 before touching anything"
  else
    fail "(g) invalid dump: $r1 $r2 $n1 $n2"
  fi
}

# (h) db not running -> exit 2, app not stopped
{
  run_restore FAKE_RUNNING=app -- --yes "$DUMP"
  if [ "$rc" -eq 2 ] && no_db_calls; then pass "(h) db not running -> exit 2, app untouched"; else fail "(h) db not running: rc=$rc"; fi
}

# (i) psql fails on the real database -> exit 1, app stays stopped and the message says so
{
  run_restore FAKE_PSQL_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && ! grep -q ' start app' "$FAKE_DOCKER_LOG" && ! grep -q ' run ' "$FAKE_DOCKER_LOG" \
    && grep -q "still stopped" <<< "$out_text" && grep -q "start app" <<< "$out_text" && no_tmp_left; then
    pass "(i) psql failure -> exit 1, app left stopped"
  else
    fail "(i) psql failure: rc=$rc"
  fi
}

# (j) app not running: no stop, no start
{
  run_restore FAKE_RUNNING=db -- --yes "$DUMP"
  if [ "$rc" -eq 0 ] && ! grep -q -E ' (stop|start) ' "$FAKE_DOCKER_LOG" && grep -q ' run --rm -T --build migrate' "$FAKE_DOCKER_LOG"; then pass "(j) app not running: not stopped, not started"; else fail "(j) app not running: rc=$rc"; fi
}

# (k) RESTORE_APP_SERVICE empty -> app left alone even when running; set -> that service is used
{
  run_restore RESTORE_APP_SERVICE= -- --yes "$DUMP"; r1=$rc; s1=0; grep -q -E ' (stop|start) ' "$FAKE_DOCKER_LOG" && s1=1
  run_restore RESTORE_APP_SERVICE=web FAKE_RUNNING="web db" -- --yes "$DUMP"; r2=$rc; s2=0; grep -q ' stop web' "$FAKE_DOCKER_LOG" && grep -q ' start web' "$FAKE_DOCKER_LOG" && s2=1
  if [ "$r1" = 0 ] && [ "$s1" = 0 ] && [ "$r2" = 0 ] && [ "$s2" = 1 ]; then
    pass "(k) RESTORE_APP_SERVICE: empty skips, a name is honoured"
  else
    fail "(k) RESTORE_APP_SERVICE: $r1 $s1 $r2 $s2"
  fi
}

# (l) compose ps failure and missing compose file -> exit 2
{
  run_restore FAKE_PS_FAIL=1 -- --yes "$DUMP"; r1=$rc
  run_restore BACKUP_COMPOSE_FILE="$WORKDIR/missing.yml" -- --yes "$DUMP"; r2=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ]; then pass "(l) compose ps failure / missing compose file -> exit 2"; else fail "(l) compose: $r1 $r2"; fi
}

# (m) the pre-restore backup fails: exit 3, nothing restored, the stopped app is started again
{
  run_restore FAKE_PGDUMP_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 3 ] && [ ! -e "$FAKE_PSQL_STDIN" ] && ! grep -q -- '-U depsight -d depsight$' "$FAKE_DOCKER_LOG" && ! grep -q ' run ' "$FAKE_DOCKER_LOG" \
    && [ "$(line_of ' stop app')" -lt "$(line_of ' start app')" ] && grep -q -- "--no-pre-backup" <<< "$out_text"; then
    pass "(m) failed pre-restore backup -> exit 3, nothing changed, app started again"
  else
    fail "(m) pre-backup failure: rc=$rc"
  fi
}

# (m2) the pre-restore backup fails and the app cannot be restarted either: still exit 3, hint printed
{
  run_restore FAKE_PGDUMP_FAIL=1 FAKE_START_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 3 ] && grep -q "could not start app" <<< "$out_text"; then pass "(m2) pre-backup failure and start failure -> exit 3 with the start command"; else fail "(m2): rc=$rc"; fi
}

# (n) the pre-restore dump never rotates: the oldest dump, restored with KEEP_FILES=1, survives
{
  rm -rf "$BACKUPS"; rm -f "$FAKE_PSQL_STDIN"
  mkdir -p "$BACKUPS"; cp "$DUMP" "$BACKUPS/depsight-20200101_000000.sql"; touch -t 202001010000 "$BACKUPS/depsight-20200101_000000.sql"
  : > "$FAKE_DOCKER_LOG"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" KEEP_FILES=1 KEEP_DAYS=1 "$RESTORE_SCRIPT" --yes "$BACKUPS/depsight-20200101_000000.sql" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -e "$BACKUPS/depsight-20200101_000000.sql" ] && [ "$(count_dumps)" = 2 ]; then
    pass "(n) pre-restore dump skips rotation, the file being restored survives"
  else
    fail "(n) rotation: rc=$rc dumps=$(count_dumps)"
  fi
}

# (o) docker compose stop fails: exit 1 before any change, no dump, no restore
{
  run_restore FAKE_STOP_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && ! grep -q -E 'pg_dump| run | start |-U depsight -d depsight$' "$FAKE_DOCKER_LOG" && [ ! -e "$FAKE_PSQL_STDIN" ] \
    && grep -q "could not stop app" <<< "$out_text"; then
    pass "(o) stop failure -> exit 1, nothing changed"
  else
    fail "(o) stop failure: rc=$rc"
  fi
}

# (p) the app does not start after a good restore: exit 4 and the command to run
{
  run_restore FAKE_START_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 4 ] && stdin_is_reset_plus_dump && grep -q "did not start" <<< "$out_text" && grep -q "start app" <<< "$out_text"; then
    pass "(p) start failure after restore -> exit 4 with the start command"
  else
    fail "(p) start failure: rc=$rc"
  fi
}

# (q) the migrate step fails: exit 4, app stays stopped, no start call
{
  run_restore FAKE_MIGRATE_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 4 ] && ! grep -q ' start app' "$FAKE_DOCKER_LOG" && grep -q "still stopped" <<< "$out_text"; then
    pass "(q) migrate failure -> exit 4, app left stopped"
  else
    fail "(q) migrate failure: rc=$rc"
  fi
}

# (r) RESTORE_MIGRATE_SERVICE: unset = migrate, empty = skipped, a name = that service
{
  run_restore -- --yes "$DUMP"; u1=0; grep -q ' run --rm -T --build migrate' "$FAKE_DOCKER_LOG" && u1=1; r1=$rc
  run_restore RESTORE_MIGRATE_SERVICE= -- --yes "$DUMP"; u2=0; grep -q ' run ' "$FAKE_DOCKER_LOG" && u2=1; r2=$rc
  run_restore RESTORE_MIGRATE_SERVICE=schema -- --yes "$DUMP"; u3=0; grep -q ' run --rm -T --build schema' "$FAKE_DOCKER_LOG" && u3=1; r3=$rc
  if [ "$r1$r2$r3" = 000 ] && [ "$u1" = 1 ] && [ "$u2" = 0 ] && [ "$u3" = 1 ]; then
    pass "(r) RESTORE_MIGRATE_SERVICE: default migrate, empty skips, a name is honoured"
  else
    fail "(r) migrate service: $r1 $r2 $r3 $u1 $u2 $u3"
  fi
}

# (s) the completion marker must be a whole line
{
  { printf -- '-- PostgreSQL database dump\n'; for i in $(seq 1 80); do printf -- 'INSERT INTO t VALUES (%d);\n' "$i"; done; printf -- 'x -- PostgreSQL database dump complete\n'; } > "$WORKDIR/rowmarker.sql"
  run_restore -- --yes "$WORKDIR/rowmarker.sql"
  if [ "$rc" -eq 1 ] && no_db_calls; then pass "(s) marker text inside a row is not a marker"; else fail "(s) row marker: rc=$rc"; fi
}

# (t) the given file disappears while the app is being stopped: the private copy is
# what gets loaded, so the whole dump is restored and committed
{
  cp "$DUMP" "$WORKDIR/vanish.sql"
  run_restore FAKE_STOP_RM="$WORKDIR/vanish.sql" -- --yes "$WORKDIR/vanish.sql"
  if [ "$rc" -eq 0 ] && [ ! -e "$WORKDIR/vanish.sql" ] && stdin_is_reset_plus_dump && no_tmp_left; then
    pass "(t) file removed after validation: the snapshot is restored in full and committed"
  else
    fail "(t) vanishing file: rc=$rc"
  fi
}

# (u) the private copy itself becomes unreadable after the scratch load: the real psql gets
# the SET lines, BEGIN, the txid capture, \o, \restrict and the reset but no COMMIT, the script exits 1 and says
# nothing was committed. The glob is under BACKUP_DIR because that is where the copy lives;
# it only removes something if restore.sh really put the copy there (proven again by (v2)).
{
  run_restore FAKE_STOP_RM="$BACKUPS/restore-dump.*" -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && [ -e "$FAKE_PSQL_STDIN" ] && ! grep -q 'COMMIT' "$FAKE_PSQL_STDIN" \
    && [ "$(sed -n 3p "$FAKE_PSQL_STDIN")" = "BEGIN;" ] && [ "$(wc -l < "$FAKE_PSQL_STDIN" | tr -d ' ')" = 11 ] \
    && grep -q "nothing was committed" <<< "$out_text" && ! grep -q "rolled back" <<< "$out_text" \
    && ! grep -q ' run ' "$FAKE_DOCKER_LOG" && ! grep -q ' start app' "$FAKE_DOCKER_LOG" \
    && grep -q "still stopped" <<< "$out_text" && no_tmp_left; then
    pass "(u) unreadable copy -> exit 1, no COMMIT sent, app left stopped"
  else
    fail "(u) unreadable copy: rc=$rc out=$out_text"
  fi
}

# (v) the temporary copy is removed on every exit path: success, refusal, invalid dump,
# stop failure, pre-backup failure, psql failure, migrate failure, the scratch stage
# failing, an old psql
{
  bad=0
  for envs in "" FAKE_STOP_FAIL=1 FAKE_PGDUMP_FAIL=1 FAKE_PSQL_FAIL=1 FAKE_MIGRATE_FAIL=1 FAKE_RUNNING=app \
    FAKE_SCRATCH_FAIL=1 FAKE_SCRATCH_NO_SENTINEL=1 FAKE_CREATEDB_FAIL=1 FAKE_DROPDB_FAIL=1 FAKE_PSQL_NO_SENTINEL=1 \
    "FAKE_PSQL_VERSION=psql (PostgreSQL) 16.9"; do
    run_restore ${envs:+"$envs"} -- --yes "$DUMP"; no_tmp_left || { bad=1; echo "  leftover after '$envs'"; }
  done
  run_restore -- --yes "$WORKDIR/tiny.sql"; no_tmp_left || { bad=1; echo "  leftover after tiny dump"; }
  run_restore -- "$DUMP"; no_tmp_left || { bad=1; echo "  leftover after refusal"; }
  if [ "$bad" = 0 ]; then pass "(v) no temporary file is left behind on any exit path"; else fail "(v) leftover temporary file"; fi
}

# (v2) the temporary copy lives under BACKUP_DIR, not TMPDIR, and backup.sh's rotation
# never matches it. Killing a "$TMPD/restore-dump.*" glob while the app stops does not
# touch the restore (the copy is not there), a file of that name under TMPDIR survives
# untouched, and a restore-dump.* file sitting in BACKUP_DIR is not rotated away while
# an old depsight-*.sql is.
{
  bad=0
  run_restore FAKE_STOP_RM="$TMPD/restore-dump.*" -- --yes "$DUMP"; r1=$rc
  [ "$r1" = 0 ] || bad=1
  touch "$TMPD/restore-dump.keep"
  run_restore -- --yes "$DUMP"
  { [ "$rc" = 0 ] && [ -e "$TMPD/restore-dump.keep" ]; } || bad=1
  rm -f "$TMPD/restore-dump.keep"
  mkdir -p "$BACKUPS"; touch "$BACKUPS/restore-dump.manually"
  cp "$DUMP" "$BACKUPS/depsight-20200101_000000.sql"; touch -t 202001010000 "$BACKUPS/depsight-20200101_000000.sql"
  env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" KEEP_FILES=1 \
    "$SCRIPT_DIR/backup.sh" > /dev/null 2>&1 || bad=1
  [ -e "$BACKUPS/restore-dump.manually" ] || bad=1
  [ -e "$BACKUPS/depsight-20200101_000000.sql" ] && bad=1 # KEEP_FILES=1 must have rotated it
  rm -f "$BACKUPS"/depsight-*.sql "$BACKUPS/restore-dump.manually"
  run_restore -- --yes "$DUMP"; no_tmp_left || bad=1
  if [ "$bad" = 0 ]; then pass "(v2) temporary copy is in BACKUP_DIR, not TMPDIR, no rotation name, gone after the run"
  else fail "(v2) copy location: r1=$r1 bad=$bad"; fi
}

# (sc) the scratch stage. A dump that fails there is refused with exit 1 before the app
# is stopped or a pre-restore dump is taken, and the scratch database is dropped by the
# exit trap; the same holds when psql exits 0 without printing the sentinel.
scratch_refused() { # scratch_refused <label> <message part> [VAR=value ...]
  local label="$1" msg="$2"; shift 2
  run_restore "$@" -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && no_real_changes && [ -s "$FAKE_SCRATCH_STDIN" ] && grep -q -F -- "$msg" <<< "$out_text" \
    && grep -q "nothing was changed" <<< "$out_text" && scratch_dropped && no_tmp_left \
    && [ "$(line_of '-d restore_scratch_[0-9a-f]*$')" -lt "$(line_of '-c DROP DATABASE')" ]; then
    pass "$label"
  else
    fail "$label: rc=$rc out=$out_text"
  fi
}
scratch_refused "(sc.1) a dump that fails in the scratch database -> exit 1, app and database untouched, scratch dropped" \
  "does not load into the scratch database" FAKE_SCRATCH_FAIL=1
scratch_refused "(sc.2) psql exits 0 in the scratch database without the sentinel -> refused like a failure" \
  "without running the COMMIT" FAKE_SCRATCH_NO_SENTINEL=1
{
  run_restore FAKE_CREATEDB_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && no_real_changes && [ ! -e "$FAKE_SCRATCH_STDIN" ] && grep -q "CREATEDB" <<< "$out_text" \
    && grep -q "nothing was changed" <<< "$out_text" && no_tmp_left; then
    pass "(sc.3) the scratch database cannot be created -> exit 1, nothing loaded, app untouched"
  else
    fail "(sc.3) CREATE DATABASE failure: rc=$rc out=$out_text"
  fi
}
{
  run_restore FAKE_DROPDB_FAIL=1 -- --yes "$DUMP"
  n_drop="$(grep -c -- '-c DROP DATABASE' "$FAKE_DOCKER_LOG" || true)"
  if [ "$rc" -eq 1 ] && no_real_changes && grep -q "could not drop the scratch database" <<< "$out_text" \
    && grep -q -F "DROP DATABASE \"$(scratch_of)\"" <<< "$out_text" && [ "$n_drop" = 1 ] && no_tmp_left; then
    pass "(sc.4) the scratch database cannot be dropped -> exit 1 with the command, tried once, nothing changed"
  else
    fail "(sc.4) DROP DATABASE failure: rc=$rc drops=$n_drop out=$out_text"
  fi
}
{
  # names, key and token: random per run, of the expected form, the same name in CREATE,
  # load and DROP, the same key in \restrict and \unrestrict, none of it from the dump
  run_restore -- --yes --no-pre-backup "$DUMP"; r1=$rc; s1="$(scratch_of)"; k1="$(sed -n 6p "$FAKE_PSQL_STDIN")"; t1="$(tail -n 1 "$FAKE_PSQL_STDIN")"
  sc_load=0; grep -q -- "-d $s1\$" "$FAKE_DOCKER_LOG" && sc_load=1
  run_restore -- --yes --no-pre-backup "$DUMP"; r2=$rc; s2="$(scratch_of)"; k2="$(sed -n 6p "$FAKE_PSQL_STDIN")"; t2="$(tail -n 1 "$FAKE_PSQL_STDIN")"
  if [ "$r1$r2" = 00 ] && [[ "$s1" =~ ^restore_scratch_[0-9a-f]{16}$ ]] && [ "$sc_load" = 1 ] && [ "$s1" != "$s2" ] \
    && [ "$k1" != "$k2" ] && [ "$t1" != "$t2" ] && ! grep -q -F -- "${k1#\\restrict }" "$DUMP" && scratch_dropped; then
    pass "(sc.5) scratch name, restrict key and sentinel token are random per run and well-formed"
  else
    fail "(sc.5) names: r=$r1/$r2 s=$s1/$s2 k=$k1/$k2 t=$t1/$t2 load=$sc_load"
  fi
}
{
  run_restore 'FAKE_KILL_ON=*-d restore_scratch_*' -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && no_real_changes && scratch_dropped && grep -q "before the load into database 'depsight' started; it is unchanged" <<< "$out_text" \
    && ! grep -q "still stopped" <<< "$out_text" && no_tmp_left; then
    pass "(sc.6) a signal during the scratch load -> exit 1 saying the database is unchanged, the trap drops the scratch database"
  else
    fail "(sc.6) signal during scratch: rc=$rc out=$out_text"
  fi
  # the same during the pre-restore dump: the app is stopped by then, the message says so
  run_restore 'FAKE_KILL_ON=* pg_dump *' -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && grep -q "it is unchanged" <<< "$out_text" && grep -q "app is still stopped" <<< "$out_text" \
    && [ ! -e "$FAKE_PSQL_STDIN" ] && no_tmp_left; then
    pass "(sc.6b) a signal during the pre-restore dump -> exit 1, database unchanged, the stopped app named"
  else
    fail "(sc.6b) signal during pre-restore dump: rc=$rc out=$out_text"
  fi
}
{
  run_restore FAKE_PSQL_NO_SENTINEL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && grep -q "without confirming the COMMIT" <<< "$out_text" && grep -q "still stopped" <<< "$out_text" \
    && ! grep -q ' run ' "$FAKE_DOCKER_LOG" && ! grep -q ' start app' "$FAKE_DOCKER_LOG" && no_tmp_left; then
    pass "(sc.7) psql exits 0 on the real database without the sentinel -> exit 1, app left stopped, no migrate"
  else
    fail "(sc.7) real load without sentinel: rc=$rc out=$out_text"
  fi
}

{
  # a DROP that fails because the dump created a subscription in the scratch database: psql's
  # error is shown, the hint says to drop the subscription first, exit 1, nothing changed
  run_restore FAKE_DROPDB_FAIL=1 'FAKE_DROPDB_ERR=ERROR:  database "x" is being used by logical replication subscription' -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && no_real_changes && grep -q "is being used by logical replication subscription" <<< "$out_text" \
    && grep -q "the dump created a subscription in it" <<< "$out_text" && grep -q "DROP SUBSCRIPTION <name>" <<< "$out_text" \
    && grep -q -F "DROP DATABASE \"$(scratch_of)\" WITH (FORCE)" <<< "$out_text" && grep -q "nothing was changed" <<< "$out_text" && no_tmp_left; then
    pass "(sc.4b) the DROP fails on a subscription -> exit 1, the error and a DROP SUBSCRIPTION hint, nothing changed"
  else
    fail "(sc.4b) DROP DATABASE failure on a subscription: rc=$rc out=$out_text"
  fi
  # any other DROP failure gets the generic hint, not the subscription one
  run_restore FAKE_DROPDB_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && grep -q "being accessed by other users" <<< "$out_text" && grep -q "(see the error above); drop it by hand" <<< "$out_text" \
    && ! grep -q "SUBSCRIPTION" <<< "$out_text"; then
    pass "(sc.4c) another DROP failure -> the error and the generic hint"
  else
    fail "(sc.4c) generic DROP failure: rc=$rc out=$out_text"
  fi
}
{
  # CREATE and DROP of the scratch database run in the maintenance database postgres, not
  # in PG_DB (a dump that dropped PG_DB in the scratch stage cannot leave it behind)
  run_restore -- --yes --no-pre-backup "$DUMP"
  if [ "$rc" -eq 0 ] && grep -q -F -- "-d postgres -c CREATE DATABASE \"$(scratch_of)\" TEMPLATE template0" "$FAKE_DOCKER_LOG" \
    && grep -q -F -- "-d postgres -c DROP DATABASE IF EXISTS \"$(scratch_of)\" WITH (FORCE)" "$FAKE_DOCKER_LOG"; then
    pass "(sc.8) the scratch database is created and dropped from the maintenance database postgres"
  else
    fail "(sc.8) maintenance database: rc=$rc log=$(cat "$FAKE_DOCKER_LOG")"
  fi
}
{
  # the tags file in the db service: a load that did not finish leaves it, the exit trap
  # removes exactly that file; a run whose loads finished makes no such call
  tags_of() { sed -n 's/^\\o \(\/tmp\/restore-[0-9a-f]*\.tags\)$/\1/p' "$1" | head -n 1; }
  run_restore FAKE_SCRATCH_FAIL=1 -- --yes "$DUMP"; r1=$rc; t1="$(tags_of "$FAKE_SCRATCH_STDIN")"
  rm1=0; grep -q -x -F -- "compose -f $COMPOSE_FILE exec -T db rm -f -- $t1" "$FAKE_DOCKER_LOG" && rm1=1
  run_restore FAKE_PSQL_NO_SENTINEL=1 -- --yes "$DUMP"; r2=$rc; t2="$(tags_of "$FAKE_PSQL_STDIN")"
  rm2=0; grep -q -x -F -- "compose -f $COMPOSE_FILE exec -T db rm -f -- $t2" "$FAKE_DOCKER_LOG" && rm2=1
  run_restore -- --yes "$DUMP"; r3=$rc; rm3="$(grep -c ' rm -f ' "$FAKE_DOCKER_LOG" || true)"
  run_restore FAKE_SCRATCH_FAIL=1 FAKE_RM_FAIL=1 -- --yes "$DUMP"; r4=$rc; m4=0; grep -q "could not remove /tmp/restore-[0-9a-f]*\.tags" <<< "$out_text" && m4=1
  if [ "$r1$r2$r3$r4" = 1101 ] && [ -n "$t1" ] && [ "$rm1$rm2" = 11 ] && [ "$rm3" = 0 ] && [ "$m4" = 1 ]; then
    pass "(sc.9) a load that did not finish: the trap removes its tags file in the db service; finished loads need no removal"
  else
    fail "(sc.9) tags file: rc=$r1/$r2/$r3/$r4 t1=$t1 rm=$rm1/$rm2/$rm3 msg=$m4"
  fi
}

# (cc) the COPY lines: a dump needs as many lines of the form COPY ... FROM stdin; as lines
# that end COPY data (exactly \., also with a carriage return), else it is refused before any
# docker call; the count goes into the COPY count check of the load
cc_dump() { # cc_dump <file> <lines before the marker>
  { printf -- '-- PostgreSQL database dump\n'
    for i in $(seq 1 50); do printf -- 'INSERT INTO t VALUES (%d);\n' "$i"; done
    printf '%b' "$2"
    printf -- '-- PostgreSQL database dump complete\n'
  } > "$1"
}
cc_refused() { # cc_refused <label> <lines> <COPY lines> <ends>
  cc_dump "$WORKDIR/cc.sql" "$2"
  run_restore -- --yes "$WORKDIR/cc.sql"
  if [ "$rc" -eq 1 ] && no_db_calls && grep -q -F "has $3 lines of the form COPY ... FROM stdin; but $4 lines that end COPY data" <<< "$out_text" && no_tmp_left; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
cc_refused "(cc.1) a COPY line without its end of data -> refused before any docker call" 'COPY public.t (a) FROM stdin;\n1\n' 1 0
cc_refused "(cc.2) a line \\. that ends no COPY -> refused before any docker call" 'SELECT 1;\n\\.\n' 0 1
cc_refused "(cc.3) a COPY that pg_dump does not write, with its end -> refused" 'COPY public.t FROM STDIN WHERE a > 0;\n1\n\\.\n' 0 1
cc_refused "(cc.4) a COPY line inside COPY data -> refused (false refusal, fail closed)" 'COPY public.t (a) FROM stdin;\nCOPY public.u (b) FROM stdin;\n\\.\n' 2 1
cc_refused "(cc.6) a server-side COPY whose line ends in FROM stdin; is not counted as a COPY of the dump" "COPY public.t FROM PROGRAM 'x' WHERE a IS DISTINCT FROM stdin;\\n1\\n\\\\.\\n" 0 1
{
  cc_dump "$WORKDIR/cc.sql" 'COPY public.t (a) FROM stdin;\n1\n\\.\nCOPY public."U v" (b, "c d") FROM stdin;\r\n2\r\n\\.\r\nCOPY public.w  FROM stdin;\n\\.\n'
  run_restore -- --yes --no-pre-backup "$WORKDIR/cc.sql"
  if [ "$rc" -eq 0 ] && wrapped_ok "$FAKE_PSQL_STDIN" "$WORKDIR/cc.sql" 3 && same_loads; then
    pass "(cc.5) three COPY blocks (one with carriage returns, one without columns) -> loaded, the check expects 3 COPY commands"
  else
    fail "(cc.5) COPY count: rc=$rc out=$out_text"
  fi
}

# (ver) the psql version of the db service: restore.sh supports 16.10+, 17.6+ and 18+; other
# versions, an unreadable answer and a failing call are refused with exit 2 before
# anything is created, loaded or stopped, and the message names what was found
version_case() { # version_case <version output> <accepted|refused>
  run_restore "FAKE_PSQL_VERSION=$1" -- --yes --no-pre-backup "$DUMP"
  if [ "$2" = accepted ]; then
    if [ "$rc" -eq 0 ] && stdin_is_reset_plus_dump; then pass "(ver) '$1' is accepted"; else fail "(ver) '$1' accepted: rc=$rc out=$out_text"; fi
  elif [ "$rc" -eq 2 ] && no_real_changes && ! grep -q 'CREATE DATABASE' "$FAKE_DOCKER_LOG" && [ ! -e "$FAKE_SCRATCH_STDIN" ] \
    && grep -q "restore.sh supports psql 16.10+, 17.6+ and 18+" <<< "$out_text" && no_tmp_left; then
    pass "(ver) '$1' is refused"
  else
    fail "(ver) '$1' refused: rc=$rc out=$out_text"
  fi
}
version_case 'psql (PostgreSQL) 16.9' refused
version_case 'psql (PostgreSQL) 16.10' accepted
version_case 'psql (PostgreSQL) 16.15 (Debian 16.15-1.pgdg120+1)' accepted
version_case 'psql (PostgreSQL) 17.5' refused
version_case 'psql (PostgreSQL) 17.6' accepted
version_case 'psql (PostgreSQL) 18.0' accepted
version_case 'psql (PostgreSQL) 15.14' refused
version_case 'psql (PostgreSQL) 9.6.24' refused
version_case 'psql (PostgreSQL) 18beta3' refused
version_case 'not psql at all' refused
version_case '' refused
{
  run_restore FAKE_VERSION_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 2 ] && no_real_changes && ! grep -q 'CREATE DATABASE' "$FAKE_DOCKER_LOG" && grep -q "could not run psql --version" <<< "$out_text"; then
    pass "(ver) a failing psql --version call is refused"
  else
    fail "(ver) psql --version failure: rc=$rc out=$out_text"
  fi
}
{
  run_restore 'FAKE_PSQL_VERSION=psql (PostgreSQL) 16.9' -- --yes "$DUMP"
  if [ "$rc" -eq 2 ] && grep -q "is 16.9;" <<< "$out_text"; then pass "(ver) the refusal names the version found"; else fail "(ver) message: $out_text"; fi
}

# (st) the \restrict and \unrestrict lines of pg_dump 16.10+: exactly that pair is stripped
# and the rest goes to psql unchanged; anything else refuses the dump before any docker
# call. pg_dump_like <file> <lines before the marker> [<lines after \unrestrict>] builds a
# dump the way pg_dump 16.10+ writes it.
RKEY=Ab1Cd2Ef3
pg_dump_like() {
  {
    printf -- '--\n-- PostgreSQL database dump\n--\n\n\\restrict %s\n\n' "$RKEY"
    for i in $(seq 1 50); do printf -- 'INSERT INTO t VALUES (%d);\n' "$i"; done
    [ -z "$2" ] || printf '%s\n' "$2"
    printf -- '--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict %s\n\n' "$RKEY"
    [ -z "${3:-}" ] || printf '%s\n' "$3"
  } > "$1"
}
# the body restore.sh must load: the file without the \restrict line and without the
# \unrestrict line and what follows it
expected_body() { # expected_body <dump> <out>
  local a b
  a="$(grep -n -m 1 '^\\restrict ' "$1" | cut -d: -f1)"; b="$(grep -n -m 1 '^\\unrestrict ' "$1" | cut -d: -f1)"
  sed -e "${a}d" -e "${b},\$d" "$1" > "$2"
}
strip_accepted() { # strip_accepted <label> <dump> [<COPY lines>]
  expected_body "$2" "$WORKDIR/expected.sql"
  run_restore -- --yes --no-pre-backup "$2"
  if [ "$rc" -eq 0 ] && wrapped_ok "$FAKE_PSQL_STDIN" "$WORKDIR/expected.sql" "${3:-0}" && same_loads \
    && ! grep -q -F "$RKEY" "$FAKE_PSQL_STDIN" && no_tmp_left; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
strip_refused() { # strip_refused <label> <dump> <message part>
  run_restore -- --yes "$2"
  if [ "$rc" -eq 1 ] && no_db_calls && [ ! -e "$FAKE_SCRATCH_STDIN" ] && grep -q -F -- "$3" <<< "$out_text" \
    && grep -q "only pg_dump's own pair is accepted" <<< "$out_text" && no_tmp_left; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
pg_dump_like "$WORKDIR/r.sql" ''
strip_accepted "(st.1) the \\restrict pair of pg_dump 16.10+ is stripped, the rest is loaded unchanged" "$WORKDIR/r.sql"
printf '%s' "$(cat "$WORKDIR/r.sql")" > "$WORKDIR/r3.sql" # $(...) drops the trailing newlines
strip_accepted "(st.2) a last \\unrestrict line without a newline is stripped" "$WORKDIR/r3.sql"
pg_dump_like "$WORKDIR/r.sql" '' $'\n\n'
strip_accepted "(st.3) blank lines after the \\unrestrict line are dropped with it" "$WORKDIR/r.sql"
pg_dump_like "$WORKDIR/r.sql" '' 'SELECT 1;'
strip_refused "(st.4) a statement after the \\unrestrict line is refused" "$WORKDIR/r.sql" "after the \\unrestrict line"
pg_dump_like "$WORKDIR/r.sql" '' '-- a comment'
strip_refused "(st.5) a comment after the \\unrestrict line is refused" "$WORKDIR/r.sql" "after the \\unrestrict line"
pg_dump_like "$WORKDIR/r.sql" "\\restrict $RKEY"
strip_refused "(st.6) a \\restrict line in the middle is refused" "$WORKDIR/r.sql" "3 \\restrict or \\unrestrict lines"
pg_dump_like "$WORKDIR/r.sql" "\\unrestrict $RKEY"
strip_refused "(st.7) an \\unrestrict line in the middle is refused" "$WORKDIR/r.sql" "3 \\restrict or \\unrestrict lines"
pg_dump_like "$WORKDIR/r.sql" "\\unrestrict $RKEY"$'\n'"\\restrict $RKEY"
strip_refused "(st.8) a second pair in the middle is refused" "$WORKDIR/r.sql" "4 \\restrict or \\unrestrict lines"
pg_dump_like "$WORKDIR/r.sql" ''; sed '/^\\unrestrict/d' "$WORKDIR/r.sql" > "$WORKDIR/r4.sql"
strip_refused "(st.9) \\restrict without \\unrestrict is refused" "$WORKDIR/r4.sql" "1 \\restrict or \\unrestrict lines"
pg_dump_like "$WORKDIR/r.sql" ''; sed '/^\\restrict/d' "$WORKDIR/r.sql" > "$WORKDIR/r4.sql"
strip_refused "(st.10) \\unrestrict without \\restrict is refused" "$WORKDIR/r4.sql" "1 \\restrict or \\unrestrict lines"
pg_dump_like "$WORKDIR/r.sql" ''; sed "s/^\\\\unrestrict $RKEY\$/\\\\unrestrict Other99/" "$WORKDIR/r.sql" > "$WORKDIR/r4.sql"
strip_refused "(st.11) \\unrestrict with another key is refused" "$WORKDIR/r4.sql" "not exactly \\unrestrict with the key of line 5"
pg_dump_like "$WORKDIR/r.sql" ''; sed '1,4s/^--$/SELECT 1;/' "$WORKDIR/r.sql" > "$WORKDIR/r4.sql"
strip_refused "(st.12) a statement before the \\restrict line is refused" "$WORKDIR/r4.sql" "a statement at line 1 before the \\restrict line"
for variant in "\\restrict $RKEY extra" " \\restrict $RKEY" "\\restrict" "\\restrict $RKEY"$'\r' "\\restrict a-b" "\\restrictX $RKEY"; do
  pg_dump_like "$WORKDIR/r.sql" ''
  { sed -n 1,4p "$WORKDIR/r.sql"; printf '%s\n' "$variant"; sed -n '6,$p' "$WORKDIR/r.sql"; } > "$WORKDIR/r4.sql"
  strip_refused "(st.13) the first line '$(printf '%s' "$variant" | tr '\r' '^')' is refused" "$WORKDIR/r4.sql" "not exactly \\restrict <key>"
done
for variant in "\\unrestrict $RKEY extra" " \\unrestrict $RKEY" "\\unrestrict" "\\unrestrict $RKEY"$'\r' "\\unrestrict $RKEY\\q"; do
  pg_dump_like "$WORKDIR/r.sql" ''
  sed "s/^\\\\unrestrict $RKEY\$/__U__/" "$WORKDIR/r.sql" | while IFS= read -r l; do
    if [ "$l" = __U__ ]; then printf '%s\n' "$variant"; else printf '%s\n' "$l"; fi
  done > "$WORKDIR/r4.sql"
  strip_refused "(st.14) the last line '$(printf '%s' "$variant" | tr '\r' '^')' is refused" "$WORKDIR/r4.sql" "not exactly \\unrestrict"
done
# a pg_dump 16.15 file: the \restrict pair, SET lines, a function, a table, COPY data with
# \N and \. and a primary key; stripped of the pair it reaches psql byte for byte
cat > "$WORKDIR/pgdump.sql" <<'PGDUMP'
--
-- PostgreSQL database dump
--

\restrict RlBbBBmfdggGtkd0kKVvk0lxqSc5xqjnNpaoAkxhQgG07o8lxgOylqL0IMXCRbR

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

ALTER TABLE IF EXISTS ONLY public.notes DROP CONSTRAINT IF EXISTS notes_pkey;
DROP TABLE IF EXISTS public.notes;
DROP FUNCTION IF EXISTS public.f();
--
-- Name: f(); Type: FUNCTION; Schema: public; Owner: depsight
--

CREATE FUNCTION public.f() RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN 1;
END;
$$;


ALTER FUNCTION public.f() OWNER TO depsight;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: notes; Type: TABLE; Schema: public; Owner: depsight
--

CREATE TABLE public.notes (
    id text NOT NULL,
    body text
);


ALTER TABLE public.notes OWNER TO depsight;

--
-- Data for Name: notes; Type: TABLE DATA; Schema: public; Owner: depsight
--

COPY public.notes (id, body) FROM stdin;
a	hello
\N	nothing
c	tab\tx
END;	a COPY line that starts with END;
\\q	a COPY line that starts with an escaped backslash
d	it's -- not a comment
\.


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: depsight
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- PostgreSQL database dump complete
--

\unrestrict RlBbBBmfdggGtkd0kKVvk0lxqSc5xqjnNpaoAkxhQgG07o8lxgOylqL0IMXCRbR

PGDUMP
RKEY=RlBbBBmfdggGtkd0kKVvk0lxqSc5xqjnNpaoAkxhQgG07o8lxgOylqL0IMXCRbR
strip_accepted "(st.15) a pg_dump 16.15 file (plpgsql END;, COPY lines with END; and \\\\q) is stripped and loaded unchanged" "$WORKDIR/pgdump.sql" 1
RKEY=Ab1Cd2Ef3

# (st.16) a grep that fails (here: a stub on PATH that exits 2 for one of the greps of the
# \restrict check) refuses the dump with "could not check" instead of passing it
grep_stub_dir="$(mktemp -d "$WORKDIR/grepstub.XXXXXX")" || { echo "FAIL: could not create the grep stub directory"; exit 1; }
real_grep="$(command -v grep)"
# GREP_STUB_FAIL_MATCH: exit 2 when the arguments contain this text.
cat > "$grep_stub_dir/grep" <<EOF4
#!/usr/bin/env bash
if [ -n "\${GREP_STUB_FAIL_MATCH:-}" ]; then
  case "\$*" in *"\$GREP_STUB_FAIL_MATCH"*) exit 2 ;; esac
fi
exec "$real_grep" "\$@"
EOF4
chmod +x "$grep_stub_dir/grep"
grep_stub_case() { # grep_stub_case <label> <dump> <stub match> <refused|accepted> <message part>
  run_restore PATH="$grep_stub_dir:$FAKE_BIN:$PATH" GREP_STUB_FAIL_MATCH="$3" -- --yes "$2"
  if [ "$4" = refused ]; then
    if [ "$rc" -eq 1 ] && no_db_calls && grep -q -F -- "could not check" <<< "$out_text" \
      && grep -q -F -- "$5" <<< "$out_text" && no_tmp_left; then
      pass "$1"
    else
      fail "$1: rc=$rc out=$out_text"
    fi
  elif [ "$rc" -eq 0 ] && no_tmp_left; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
pg_dump_like "$WORKDIR/r.sql" ''
grep_stub_case "(st.16a) the \\restrict line grep failing (exit 2) refuses the dump" "$WORKDIR/r.sql" '(un)?restrict' refused "restrict line check failed"
grep_stub_case "(st.16b) the \\restrict position grep failing refuses the dump" "$WORKDIR/r.sql" '^(--.*)?$' refused "restrict position check failed"
grep_stub_case "(st.16c) the \\unrestrict position grep failing refuses the dump" "$WORKDIR/r.sql" '-v -x' refused "unrestrict position check failed"
grep_stub_case "(st.16d) without \\restrict lines the position greps do not run, so their failure does not matter (control)" "$DUMP" '^(--.*)?$' accepted ""
grep_stub_case "(st.16e) the stub with no failure configured lets the dump through (control)" "$WORKDIR/r.sql" '' accepted ""

# (w5) a dump whose last byte is not a newline: the trailer starts its own line, so a final
# -- comment cannot swallow it; a dump that ends in a newline gets no extra line
{
  { cat "$DUMP"; printf -- '-- trailing note, no newline'; } > "$WORKDIR/nonl.sql"
  run_restore -- --yes --no-pre-backup "$WORKDIR/nonl.sql"
  { cat "$WORKDIR/nonl.sql"; printf '\n'; } > "$WORKDIR/nonl-expected.sql"
  if [ "$rc" -eq 0 ] && wrapped_ok "$FAKE_PSQL_STDIN" "$WORKDIR/nonl-expected.sql" && same_loads; then
    pass "(w5.1) a dump that ends in a comment without a newline gets its trailer on a line of its own"
  else
    fail "(w5.1) no trailing newline: rc=$rc out=$out_text"
  fi
  { cat "$DUMP"; printf -- '-- trailing note\n'; } > "$WORKDIR/nl.sql"
  run_restore -- --yes --no-pre-backup "$WORKDIR/nl.sql"
  if [ "$rc" -eq 0 ] && wrapped_ok "$FAKE_PSQL_STDIN" "$WORKDIR/nl.sql"; then
    pass "(w5.3) a dump that ends in a newline gets no extra line before the trailer"
  else
    fail "(w5.3) trailing newline: rc=$rc"
  fi
}

# (w8) a NUL byte anywhere refuses the dump before anything else is looked at, and the
# message names the line (counted in line feeds)
nul_case() {
  run_restore -- --yes "$WORKDIR/nul.sql"
  if [ "$rc" -eq 1 ] && no_db_calls && [ ! -e "$FAKE_PSQL_STDIN" ] && no_tmp_left \
    && grep -q -F -- "contains a NUL byte (first at line $2)" <<< "$out_text"; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
{ sed '/^-- PostgreSQL database dump complete/,$d' "$DUMP"; printf '\0\nCOMMIT;\n'; printf -- '-- PostgreSQL database dump complete\n'; } > "$WORKDIR/nul.sql"
nul_case "(w8.1) a NUL on its own line before a COMMIT; line is refused as a NUL" 52
{ cat "$DUMP"; printf '\0'; } > "$WORKDIR/nul.sql"
nul_case "(w8.2) a NUL as the last byte of the dump is refused" 53
{ sed '/^-- PostgreSQL database dump complete/,$d' "$DUMP"; printf -- '-- a\0b\nSELECT 1;\n'; printf -- '-- PostgreSQL database dump complete\n'; } > "$WORKDIR/nul.sql"
nul_case "(w8.3) a NUL inside a comment line is refused" 52
{ sed '/^-- PostgreSQL database dump complete/,$d' "$DUMP"; printf 'SELECT 1;\n\\q\n\0'; printf -- '\n-- PostgreSQL database dump complete\n'; } > "$WORKDIR/nul.sql"
nul_case "(w8.4) the NUL is named before a later backslash command" 54

# (x) the migrate failure message names the step, not only newer code
{
  run_restore FAKE_MIGRATE_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 4 ] && grep -q "migrate step (image build or schema push) failed; see the output above" <<< "$out_text"; then
    pass "(x) migrate failure message names the step and points at the output"
  else
    fail "(x) migrate message: rc=$rc"
  fi
}

# (y) the copy of the dump into BACKUP_DIR fails (target not writable): exit 1, the
# message names both ends of the copy, nothing was touched
{
  run_restore FAKE_CP_FAIL=1 -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && no_db_calls && grep -q "could not copy $DUMP to $BACKUPS/restore-dump." <<< "$out_text"; then
    pass "(y) failed copy -> exit 1, 'could not copy <file> to <path>'"
  else
    fail "(y) failed copy: rc=$rc out=$out_text"
  fi
}

# (z) a TERM signal while the psql load of the real database runs (the COMMIT is not known
# yet): exit 1, no claim that anything was committed, no migrate or start call, no leftover
REAL_LOAD='*ON_ERROR_STOP=1 -U depsight -d depsight'
{
  run_restore "FAKE_KILL_ON=$REAL_LOAD" -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && ! grep -q "committed" <<< "$out_text" && grep -q "check it before assuming it is unchanged" <<< "$out_text" \
    && ! grep -q ' run ' "$FAKE_DOCKER_LOG" \
    && ! grep -q ' start app' "$FAKE_DOCKER_LOG" && no_tmp_left; then
    pass "(z) signal before the COMMIT -> exit 1, nothing reported as committed"
  else
    fail "(z) signal before COMMIT: rc=$rc out=$out_text"
  fi
}

# (z4) an existing BACKUP_DIR keeps its mode (only a directory the script creates is
# made 700), and the restore still succeeds with the copy taken there
{
  existing="$WORKDIR/existing-backups"; rm -rf "$existing"; mkdir -p "$existing"; chmod 755 "$existing"
  run_restore BACKUP_DIR="$existing" -- --yes --no-pre-backup "$DUMP"
  mode="$(stat -c '%a' "$existing" 2>/dev/null || stat -f '%Lp' "$existing")"
  if [ "$rc" -eq 0 ] && [ "$mode" = 755 ] && [ -z "$(find "$existing" -maxdepth 1 -name 'restore-dump.*')" ]; then
    pass "(z4) existing BACKUP_DIR keeps mode 755, copy removed"
  else
    fail "(z4) existing BACKUP_DIR: rc=$rc mode=$mode out=$out_text"
  fi
}

# (z2) a TERM signal during the migrate run call and (z3) during the app start call:
# the restore is committed (psql returned), so exit 4 with a message saying so and
# naming the commands that are left
{
  run_restore 'FAKE_KILL_ON=* run *' -- --yes "$DUMP"; r1=$rc
  k1=0; grep -q "committed" <<< "$out_text" && k1=1
  run_restore 'FAKE_KILL_ON=* start *' -- --yes "$DUMP"; r2=$rc
  k2=0; grep -q "committed" <<< "$out_text"; k2=$?
  if [ "$r1" = 4 ] && [ "$k1" = 1 ] && [ "$r2" = 4 ] && [ "$k2" = 0 ] && grep -q "start app" <<< "$out_text" && no_tmp_left; then
    pass "(z2) signal after the COMMIT -> exit 4 saying the restore is committed (migrate and start)"
  else
    fail "(z2) signal after COMMIT: r1=$r1 k1=$k1 r2=$r2 out=$out_text"
  fi
}

# (z3) HUP and INT are handled like TERM, before and after the COMMIT
{
  run_restore "FAKE_KILL_ON=$REAL_LOAD" FAKE_KILL_SIGNAL=HUP -- --yes "$DUMP"; r1=$rc
  run_restore "FAKE_KILL_ON=$REAL_LOAD" FAKE_KILL_SIGNAL=INT -- --yes "$DUMP"; r2=$rc
  run_restore 'FAKE_KILL_ON=* run *' FAKE_KILL_SIGNAL=HUP -- --yes "$DUMP"; r3=$rc
  k3=0; grep -q "committed" <<< "$out_text" && k3=1
  run_restore 'FAKE_KILL_ON=* run *' FAKE_KILL_SIGNAL=INT -- --yes "$DUMP"; r4=$rc
  if [ "$r1" = 1 ] && [ "$r2" = 1 ] && [ "$r3" = 4 ] && [ "$k3" = 1 ] && [ "$r4" = 4 ]; then
    pass "(z3) HUP and INT exit 1 before the COMMIT and 4 with the committed message after it"
  else
    fail "(z3) HUP/INT: r1=$r1 r2=$r2 r3=$r3 k3=$k3 r4=$r4"
  fi
}

# (sh1) skipping the migrate step is announced: an empty RESTORE_MIGRATE_SERVICE (the
# self-hosting docker-compose.yml has no migrate service) prints the skip and the way
# to apply the schema; unset (migrate runs) and a named service print nothing of it
{
  run_restore RESTORE_MIGRATE_SERVICE= -- --yes "$DUMP"; r1=$rc; o1="$out_text"
  s1=0; grep -q "schema step skipped" <<< "$o1" && s1=1
  d1=0; grep -q "restore: done" <<< "$o1" && d1=1
  run_restore -- --yes "$DUMP"; r2=$rc; s2=0; grep -q "schema step skipped" <<< "$out_text" && s2=1
  run_restore RESTORE_MIGRATE_SERVICE=schema -- --yes "$DUMP"; r3=$rc; s3=0; grep -q "schema step skipped" <<< "$out_text" && s3=1
  if [ "$r1$r2$r3" = 000 ] && [ "$s1" = 1 ] && [ "$d1" = 1 ] && [ "$s2" = 0 ] && [ "$s3" = 0 ]; then
    pass "(sh1) empty RESTORE_MIGRATE_SERVICE says the schema step was skipped; unset and a name do not"
  else
    fail "(sh1) skip message: rc=$r1/$r2/$r3 skipped=$s1/$s2/$s3 done=$d1"
  fi
}

# (sh2) BACKUP_COMPOSE_FILE precedence, with the variable truly absent (run_restore
# always sets it): unset and empty both fall back to the hosted docker-compose.traefik.yml
# of the checkout, a non-empty value wins and is the file used for every compose call,
# including the pre-restore dump that backup.sh takes
{
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  SELF_COMPOSE="$WORKDIR/docker-compose.yml"; : > "$SELF_COMPOSE"
  # run_compose_case <unset|empty|set>: sets rc, files_used (distinct -f arguments in the log)
  run_compose_case() {
    : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN" "$FAKE_SCRIPT_PID"; rm -rf "$BACKUPS"
    rc=0
    case "$1" in
      unset) env -u BACKUP_COMPOSE_FILE PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" "$RESTORE_SCRIPT" --yes "$DUMP" > "$WORKDIR/out" 2>&1 || rc=$? ;;
      empty) env BACKUP_COMPOSE_FILE= PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" "$RESTORE_SCRIPT" --yes "$DUMP" > "$WORKDIR/out" 2>&1 || rc=$? ;;
      set) env BACKUP_COMPOSE_FILE="$SELF_COMPOSE" PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" "$RESTORE_SCRIPT" --yes "$DUMP" > "$WORKDIR/out" 2>&1 || rc=$? ;;
    esac
    files_used="$(grep -o -- 'compose -f [^ ]*' "$FAKE_DOCKER_LOG" | sort -u | tr '\n' ' ')"
  }
  run_compose_case unset; c1="$rc"; f1="$files_used"
  run_compose_case empty; c2="$rc"; f2="$files_used"
  run_compose_case set; c3="$rc"; f3="$files_used"
  if [ "$c1$c2$c3" = 000 ] \
    && [ "$f1" = "compose -f $REPO_DIR/docker-compose.traefik.yml " ] \
    && [ "$f2" = "compose -f $REPO_DIR/docker-compose.traefik.yml " ] \
    && [ "$f3" = "compose -f $SELF_COMPOSE " ]; then
    pass "(sh2) BACKUP_COMPOSE_FILE: unset and empty use the hosted file, a set value wins everywhere"
  else
    fail "(sh2) compose file precedence: rc=$c1/$c2/$c3 used=[$f1] [$f2] [$f3]"
  fi
}

echo "restore tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
