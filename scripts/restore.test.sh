#!/usr/bin/env bash
# Test driver for scripts/restore.sh with a fake `docker` on PATH.
#   bash scripts/restore.test.sh
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
export FAKE_PSQL_STDIN="$WORKDIR/psql_stdin"
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

cat > "$FAKE_BIN/docker" <<EOF2
#!/usr/bin/env bash
echo "\$*" >> "\$FAKE_DOCKER_LOG"
# FAKE_KILL_ON: signal restore.sh during one kind of call, to exercise its traps
# ("exec psql" runs before the COMMIT is known, "run" and "start" after it). The
# driver writes restore.sh's PID to \$FAKE_SCRIPT_PID before it can call docker.
if [ -n "\${FAKE_KILL_ON:-}" ] && case "\$*" in *" \${FAKE_KILL_ON} "*) true ;; *) false ;; esac; then
  if [ -s "\$FAKE_SCRIPT_PID" ]; then kill -s "\${FAKE_KILL_SIGNAL:-TERM}" "\$(cat "\$FAKE_SCRIPT_PID")" 2> /dev/null; fi
fi
case "\$*" in
  *" ps "*) [ "\${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' \${FAKE_RUNNING:-app db}; exit 0 ;;
  *" exec "*pg_dump*)
    [ "\${FAKE_PGDUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: fatal error" >&2; exit 1; }
    cat "$DUMP"; exit 0 ;;
  *" exec "*psql*)
    cat > "\$FAKE_PSQL_STDIN"
    [ "\${FAKE_PSQL_FAIL:-0}" = 1 ] && { echo "psql: ERROR" >&2; exit 3; }
    exit 0 ;;
  *" stop "*)
    # FAKE_STOP_RM: files (glob allowed) that disappear while the app is being stopped
    # shellcheck disable=SC2086
    [ -z "\${FAKE_STOP_RM:-}" ] || rm -f \$FAKE_STOP_RM
    [ "\${FAKE_STOP_FAIL:-0}" = 1 ] && { echo "stop: error" >&2; exit 5; }; exit 0 ;;
  *" start "*) [ "\${FAKE_START_FAIL:-0}" = 1 ] && { echo "start: error" >&2; exit 5; }; exit 0 ;;
  *" run "*) [ "\${FAKE_MIGRATE_FAIL:-0}" = 1 ] && { echo "migrate: error" >&2; exit 5; }; exit 0 ;;
  *) echo "fake docker: unexpected call: \$*" >&2; exit 9 ;;
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
  : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN" "$FAKE_SCRIPT_PID"; rm -rf "$BACKUPS"
  rc=0
  env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" TMPDIR="$TMPD" ${envs[@]+"${envs[@]}"} "$RESTORE_SCRIPT" "$@" \
    > "$WORKDIR/out" 2>&1 &
  pid="$!"
  printf '%s' "$pid" > "$FAKE_SCRIPT_PID"
  wait "$pid" || rc=$?
  out_text="$(cat "$WORKDIR/out")"
}
no_db_calls() { ! grep -q -E ' (exec|stop|start|run) ' "$FAKE_DOCKER_LOG"; }
line_of() { grep -n -- "$1" "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true; }
count_dumps() { find "$BACKUPS" -maxdepth 1 -name 'depsight-*.sql' 2>/dev/null | wc -l | tr -d ' '; }
# the stdin psql saw must be BEGIN, the schema reset, the dump byte for byte, then COMMIT
stdin_is_reset_plus_dump() {
  local n; n="$(wc -l < "$DUMP" | tr -d ' ')"
  [ "$(sed -n 1p "$FAKE_PSQL_STDIN")" = "BEGIN;" ] \
    && [ "$(sed -n 3p "$FAKE_PSQL_STDIN")" = "DROP SCHEMA public CASCADE;" ] \
    && grep -q '^CREATE SCHEMA public AUTHORIZATION pg_database_owner;$' "$FAKE_PSQL_STDIN" \
    && grep -q '^GRANT USAGE ON SCHEMA public TO PUBLIC;$' "$FAKE_PSQL_STDIN" \
    && sed -n "7,$((6 + n))p" "$FAKE_PSQL_STDIN" | cmp -s - "$DUMP" \
    && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ] \
    && [ "$(wc -l < "$FAKE_PSQL_STDIN" | tr -d ' ')" = "$((7 + n))" ]
}
no_tmp_left() {
  [ -z "$(find "$TMPD" -mindepth 1 2>/dev/null)" ] \
    && [ -z "$(find "$BACKUPS" -maxdepth 1 -name 'restore-dump.*' 2>/dev/null)" ]
}

# (a) success: stop app, pre-restore dump, schema reset + dump in one transaction, migrate, start app
{
  run_restore -- --yes "$DUMP"
  l_stop="$(line_of ' stop app')"; l_dump="$(line_of ' pg_dump ')"; l_psql="$(line_of 'psql -v ON_ERROR_STOP=1')"
  l_mig="$(line_of ' run --rm -T --build migrate')"; l_start="$(line_of ' start app')"
  if [ "$rc" -eq 0 ] && stdin_is_reset_plus_dump \
    && grep -q "exec -T db psql -v ON_ERROR_STOP=1 -q -U depsight -d depsight" "$FAKE_DOCKER_LOG" \
    && ! grep -q -- "--single-transaction" "$FAKE_DOCKER_LOG" && no_tmp_left \
    && [ "$l_stop" -lt "$l_dump" ] && [ "$l_dump" -lt "$l_psql" ] && [ "$l_psql" -lt "$l_mig" ] && [ "$l_mig" -lt "$l_start" ] \
    && [ "$(count_dumps)" = 1 ]; then
    pass "(a) success: stop app, pre-backup, reset + dump, migrate, start app, in that order"
  else
    fail "(a) success: rc=$rc order=$l_stop,$l_dump,$l_psql,$l_mig,$l_start dumps=$(count_dumps)"
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

# (i) psql fails -> exit 1, app stays stopped and the message says so
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
  if [ "$rc" -eq 3 ] && [ ! -e "$FAKE_PSQL_STDIN" ] && ! grep -q 'psql' "$FAKE_DOCKER_LOG" && ! grep -q ' run ' "$FAKE_DOCKER_LOG" \
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
  if [ "$rc" -eq 1 ] && ! grep -q -E 'pg_dump|psql| run | start ' "$FAKE_DOCKER_LOG" && grep -q "could not stop app" <<< "$out_text"; then
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

# (u) the private copy itself becomes unreadable after validation: psql gets BEGIN and the
# reset but no COMMIT, the script exits 1 and says nothing was committed. The glob is
# under BACKUP_DIR because that is where the copy lives; it only removes something if
# restore.sh really put the copy there (proven again by case (v2)).
{
  run_restore FAKE_STOP_RM="$BACKUPS/restore-dump.*" -- --yes "$DUMP"
  if [ "$rc" -eq 1 ] && [ -e "$FAKE_PSQL_STDIN" ] && ! grep -q 'COMMIT' "$FAKE_PSQL_STDIN" \
    && [ "$(sed -n 1p "$FAKE_PSQL_STDIN")" = "BEGIN;" ] \
    && grep -q "nothing was committed" <<< "$out_text" && ! grep -q "rolled back" <<< "$out_text" \
    && ! grep -q ' run ' "$FAKE_DOCKER_LOG" && ! grep -q ' start app' "$FAKE_DOCKER_LOG" \
    && grep -q "still stopped" <<< "$out_text" && no_tmp_left; then
    pass "(u) unreadable copy -> exit 1, no COMMIT sent, app left stopped"
  else
    fail "(u) unreadable copy: rc=$rc"
  fi
}

# (v) the temporary copy is removed on every exit path: success, refusal, invalid dump,
# stop failure, pre-backup failure, psql failure, migrate failure
{
  bad=0
  for envs in "" FAKE_STOP_FAIL=1 FAKE_PGDUMP_FAIL=1 FAKE_PSQL_FAIL=1 FAKE_MIGRATE_FAIL=1 FAKE_RUNNING=app; do
    run_restore ${envs:+"$envs"} -- --yes "$DUMP"; no_tmp_left || { bad=1; echo "  leftover after '$envs'"; }
  done
  run_restore -- --yes "$WORKDIR/tiny.sql"; no_tmp_left || { bad=1; echo "  leftover after tiny dump"; }
  run_restore -- "$DUMP"; no_tmp_left || { bad=1; echo "  leftover after refusal"; }
  if [ "$bad" = 0 ]; then pass "(v) no temporary copy is left behind on any exit path"; else fail "(v) leftover temporary copy"; fi
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

# (w) a dump with transaction control statements is refused before anything is touched
{
  for stmt in 'COMMIT;' 'begin;' 'END;'; do
    { cat "$DUMP"; } | awk -v s="$stmt" '/^-- PostgreSQL database dump complete/ { print s } { print }' > "$WORKDIR/txn.sql"
    run_restore -- --yes "$WORKDIR/txn.sql"
    if [ "$rc" -ne 1 ] || ! no_db_calls || ! grep -q "transaction control" <<< "$out_text"; then bad_w="$stmt"; fi
  done
  if [ -z "${bad_w:-}" ]; then pass "(w) transaction control statement in the dump -> exit 1 before touching anything"; else fail "(w) txn statement not refused: $bad_w"; fi
}

# Guard cases. guard_dump puts the lines of $2 before the completion marker of the good
# dump; guard_refused / guard_accepted run restore.sh on it. A refusal is exit 1 with the
# given message part, no docker call at all (database and app untouched) and no leftover
# copy; an accepted dump reaches psql with its first guard line intact and ends in COMMIT.
guard_dump() {
  { sed '/^-- PostgreSQL database dump complete/,$d' "$DUMP"; printf '%s\n' "$2"; printf -- '-- PostgreSQL database dump complete\n'; } > "$1"
}
# Optional arguments: $4 the line number the message must name ("first at line N,"),
# $5 the LC_ALL the script runs under.
guard_refused() {
  local at="${4:-}" loc="${5:-}" envs=()
  [ -z "$loc" ] || envs=("LC_ALL=$loc")
  guard_dump "$WORKDIR/guard.sql" "$2"
  run_restore ${envs[@]+"${envs[@]}"} -- --yes "$WORKDIR/guard.sql"
  if [ "$rc" -eq 1 ] && no_db_calls && [ ! -e "$FAKE_PSQL_STDIN" ] && grep -q -F -- "$3" <<< "$out_text" && no_tmp_left \
    && { [ -z "$at" ] || grep -q -F -- "first at line $at," <<< "$out_text"; }; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
guard_accepted() {
  local loc="${3:-}" envs=()
  [ -z "$loc" ] || envs=("LC_ALL=$loc")
  guard_dump "$WORKDIR/guard.sql" "$2"
  run_restore ${envs[@]+"${envs[@]}"} -- --yes --no-pre-backup "$WORKDIR/guard.sql"
  if [ "$rc" -eq 0 ] && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ] \
    && sed -n '7,$p' "$FAKE_PSQL_STDIN" | sed '$d' | cmp -s - "$WORKDIR/guard.sql" && no_tmp_left; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
TX="transaction control statements"
BS="psql backslash command"
NL=$'\n'
TAB=$'\t'

# (w2) one case per refused transaction form: each keyword, with and without its optional words
guard_refused "(w2.1) BEGIN; is refused" 'BEGIN;' "$TX"
guard_refused "(w2.2) BEGIN WORK; is refused" 'begin work;' "$TX"
guard_refused "(w2.3) BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE; is refused" 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;' "$TX"
guard_refused "(w2.4) START TRANSACTION READ ONLY; is refused" 'START TRANSACTION READ ONLY;' "$TX"
guard_refused "(w2.5) START TRANSACTION with several modes, extra white space, is refused" 'start   transaction isolation level repeatable read, read write, not deferrable;' "$TX"
guard_refused "(w2.5b) BEGIN ISOLATION LEVEL READ COMMITTED; is refused" 'BEGIN ISOLATION LEVEL READ COMMITTED;' "$TX"
guard_refused "(w2.5c) BEGIN ISOLATION LEVEL READ UNCOMMITTED; is refused" 'BEGIN ISOLATION LEVEL READ UNCOMMITTED;' "$TX"
guard_refused "(w2.6) COMMIT WORK; is refused" 'COMMIT WORK;' "$TX"
guard_refused "(w2.7) COMMIT AND NO CHAIN; is refused" 'COMMIT AND NO CHAIN;' "$TX"
guard_refused "(w2.8) COMMIT TRANSACTION; is refused" 'commit transaction;' "$TX"
guard_refused "(w2.9) END TRANSACTION; is refused" 'END TRANSACTION;' "$TX"
guard_refused "(w2.10) END WORK AND CHAIN; is refused" 'END WORK AND CHAIN;' "$TX"
guard_refused "(w2.11) ROLLBACK; is refused" 'ROLLBACK;' "$TX"
guard_refused "(w2.12) ROLLBACK AND CHAIN; is refused" 'ROLLBACK AND CHAIN;' "$TX"
guard_refused "(w2.13) ABORT; is refused" 'abort;' "$TX"
guard_refused "(w2.14) ABORT WORK; is refused" 'ABORT WORK;' "$TX"
guard_refused "(w2.15) white space before the ';' is refused" "COMMIT${TAB} ;" "$TX"
guard_refused "(w2.16) an indented COMMIT; is refused" "    COMMIT;" "$TX"
guard_refused "(w2.17) a tab-indented COMMIT; is refused" "${TAB}${TAB}COMMIT;" "$TX"
guard_refused "(w2.18) COMMIT PREPARED is refused" "COMMIT PREPARED 'x';" "$TX"
guard_refused "(w2.19) ROLLBACK PREPARED is refused" "rollback prepared 'x';" "$TX"
guard_refused "(w2.20) PREPARE TRANSACTION is refused" "PREPARE TRANSACTION 'x';" "$TX"
guard_refused "(w2.21) PREPARE TRANSACTION without a ';' on the line is refused" "PREPARE TRANSACTION 'x'" "$TX"
guard_refused "(w2.22) COMMIT PREPARED without a ';' on the line is refused" "COMMIT PREPARED 'x'" "$TX"
# after a ';' on the same line
guard_refused "(w2.23) SELECT 1; COMMIT; is refused" 'SELECT 1; COMMIT;' "$TX"
guard_refused "(w2.24) SELECT 1;COMMIT; (no space) is refused" 'SELECT 1;COMMIT;' "$TX"
guard_refused "(w2.25) SELECT 1; END; is refused" 'SELECT 1; END;' "$TX"
guard_refused "(w2.26) SELECT 1; BEGIN; is refused" 'SELECT 1; BEGIN;' "$TX"
guard_refused "(w2.27) SELECT 1; ROLLBACK; is refused" 'SELECT 1; rollback;' "$TX"
guard_refused "(w2.28) SELECT 1; ABORT; is refused" 'SELECT 1; ABORT;' "$TX"
guard_refused "(w2.29) SELECT 1; START TRANSACTION; is refused" 'SELECT 1; START TRANSACTION;' "$TX"
guard_refused "(w2.30) SELECT 1; COMMIT PREPARED is refused" "SELECT 1; COMMIT PREPARED 'x'" "$TX"
guard_refused "(w2.31) SELECT 1; PREPARE TRANSACTION is refused" "SELECT 1; PREPARE TRANSACTION 'x'" "$TX"
# the ';' on a later line
guard_refused "(w2.32) COMMIT alone on a line is refused" "COMMIT${NL};" "$TX"
guard_refused "(w2.33) ROLLBACK followed by a comment is refused" "ROLLBACK -- note${NL};" "$TX"
guard_refused "(w2.34) START TRANSACTION alone on a line is refused" "START TRANSACTION${NL};" "$TX"
guard_refused "(w2.35) ABORT alone on a line is refused" "ABORT${NL};" "$TX"
guard_refused "(w2.36) COMMIT AND CHAIN alone on a line is refused" "SELECT 1; COMMIT AND CHAIN${NL};" "$TX"
guard_refused "(w2.37) the refusal names the line" "SELECT 1;${NL}COMMIT;" "first at line "

# (w3) psql meta-commands at the start of a line
guard_refused "(w3.1) \\c is refused" '\c other' "$BS"
guard_refused "(w3.2) \\connect is refused" '\connect other' "$BS"
guard_refused "(w3.3) \\q is refused" '\q' "$BS"
guard_refused "(w3.4) \\quit is refused" '\quit' "$BS"
guard_refused "(w3.5) \\i is refused" '\i /etc/passwd' "$BS"
guard_refused "(w3.6) \\ir is refused" '\ir other.sql' "$BS"
guard_refused "(w3.7) \\include is refused" '\include other.sql' "$BS"
guard_refused "(w3.8) \\! is refused" '\! id' "$BS"
guard_refused "(w3.9) \\gexec is refused" '\gexec' "$BS"
guard_refused "(w3.10) \\set is refused" '\set ON_ERROR_STOP 0' "$BS"
guard_refused "(w3.11) an indented \\c is refused" '   \c other' "$BS"
guard_refused "(w3.12) a tab-indented \\q is refused" "${TAB}\\q" "$BS"
guard_refused "(w3.13) text after a \\restrict key is refused" '\restrict Ab1Cd2Ef3 extra' "$BS"
guard_refused "(w3.14) an indented \\restrict line is refused" ' \restrict Ab1Cd2Ef3' "$BS"
guard_refused "(w3.15) a \\restrict line without a key is refused" '\restrict' "$BS"
guard_refused "(w3.16) a command chained onto an \\unrestrict key is refused" '\unrestrict Ab1Cd2Ef3\q' "$BS"
guard_refused "(w3.17) a line that starts with two backslashes is refused" '\\\c other' "$BS"
guard_refused "(w3.18) \\. followed by text is refused" '\.\q' "$BS"
guard_refused "(w3.19) a \\C-like uppercase command is refused" '\C title' "$BS"
guard_refused "(w3.20) the refusal names the line" "SELECT 1;${NL}\\q" "first at line "

# positive controls: what a plain dump holds still passes
guard_accepted "(w4.1) a bare BEGIN line (a plpgsql body) is accepted" "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS \$\$${NL}BEGIN${NL}  IF true THEN${NL}    RETURN 1;${NL}  END IF;${NL}  FOR i IN 1..2 LOOP${NL}    NULL;${NL}  END LOOP;${NL}  RETURN 0;${NL}END${NL}\$\$;"
guard_accepted "(w4.2) SAVEPOINT, RELEASE and ROLLBACK TO are accepted" "SAVEPOINT a;${NL}RELEASE a;${NL}ROLLBACK TO a;${NL}RELEASE SAVEPOINT a;"
guard_accepted "(w4.3) the \\restrict and \\unrestrict lines of pg_dump 16.10+ are accepted" "\\restrict Ab1Cd2Ef3${NL}SELECT 1;${NL}\\unrestrict Ab1Cd2Ef3"
guard_accepted "(w4.4) COPY data with \\N, \\. and a keyword inside a value is accepted" "COPY t (a, b) FROM stdin;${NL}\\N${TAB}x${NL}\\N${TAB}\\N${NL}k${TAB}commit${NL}\\."
guard_accepted "(w4.5) a column or word that merely starts with a keyword is accepted" "CREATE TABLE u (${NL}    commit text,${NL}    \"end\" text,${NL}    abort boolean NOT NULL,${NL}    rollback_at timestamp,${NL}    beginning text${NL});"
guard_accepted "(w4.6) CASE ... END AS and ENDPOINT are accepted" "CREATE VIEW v AS SELECT CASE WHEN a THEN 1 ELSE 2${NL}END AS x, 1 AS endpoint FROM t;"
guard_accepted "(w4.7) a statement that only mentions the words is accepted" "COMMENT ON TABLE t IS 'we commit and end the work here';"
guard_accepted "(w4.8) a comment line that mentions the words is accepted" "-- the commit and end of begin: abort, rollback"
# known false refusals (fail closed): the shape inside a comment or a string is refused too
guard_refused "(w4.8b) a comment with '; COMMIT;' in it is refused (known limitation)" "-- note: SELECT 1; COMMIT; here" "$TX"
guard_refused "(w4.8c) a string with a line that starts with END; is refused (known limitation)" "INSERT INTO t VALUES ('a${NL}END;${NL}b');" "$TX"
guard_refused "(w4.8d) a string with a line that starts with \\q is refused (known limitation)" "INSERT INTO t VALUES ('a${NL}\\q${NL}b');" "$BS"
# the documented limitation: the END; that closes a plpgsql body is a refusal
guard_refused "(w4.9) a plpgsql body that ends with END; is refused (known limitation)" "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS \$\$${NL}BEGIN${NL}  RETURN 0;${NL}END;${NL}\$\$;" "$TX"

# (w4.10) a pg_dump 16 file without a plpgsql END; line passes whole: the \restrict pair, SET
# lines, a LANGUAGE sql function, a table, COPY data with \N and \. and a primary key
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
    LANGUAGE sql
    AS $$ SELECT 1 $$;


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
{
  run_restore -- --yes --no-pre-backup "$WORKDIR/pgdump.sql"
  n="$(wc -l < "$WORKDIR/pgdump.sql" | tr -d ' ')"
  if [ "$rc" -eq 0 ] && sed -n "7,$((6 + n))p" "$FAKE_PSQL_STDIN" | cmp -s - "$WORKDIR/pgdump.sql" \
    && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ] && no_tmp_left; then
    pass "(w4.10) a pg_dump 16.15 file without a plpgsql END; line (\\restrict pair, COPY with \\N) is accepted"
  else
    fail "(w4.10) pg_dump sample: rc=$rc out=$out_text"
  fi
  # the same file with a COMMIT; or a \q line added is refused
  { sed '/^\\unrestrict/d' "$WORKDIR/pgdump.sql"; printf 'COMMIT;\n'; } > "$WORKDIR/pgdump-commit.sql"
  run_restore -- --yes "$WORKDIR/pgdump-commit.sql"
  if [ "$rc" -eq 1 ] && no_db_calls && grep -q -F -- "$TX" <<< "$out_text"; then
    pass "(w4.11) the pg_dump file with a COMMIT; added is refused"
  else
    fail "(w4.11) pg_dump file plus COMMIT: rc=$rc out=$out_text"
  fi
  { sed '/^\\unrestrict/d' "$WORKDIR/pgdump.sql"; printf '\\q\n'; } > "$WORKDIR/pgdump-q.sql"
  run_restore -- --yes "$WORKDIR/pgdump-q.sql"
  if [ "$rc" -eq 1 ] && no_db_calls && grep -q -F -- "$BS" <<< "$out_text"; then
    pass "(w4.12) the pg_dump file with a \\q line added is refused"
  else
    fail "(w4.12) pg_dump file plus \\q: rc=$rc out=$out_text"
  fi
}

# (w5) a dump whose last byte is not a newline: the appended COMMIT starts its own line,
# so a final -- comment cannot swallow it (psql would roll back and the restore would
# report success); a dump that ends in a newline gets no extra line (case (a))
{
  { cat "$DUMP"; printf -- '-- trailing note, no newline'; } > "$WORKDIR/nonl.sql"
  run_restore -- --yes --no-pre-backup "$WORKDIR/nonl.sql"
  n="$(wc -l < "$DUMP" | tr -d ' ')"
  if [ "$rc" -eq 0 ] && sed -n "7,$((6 + n))p" "$FAKE_PSQL_STDIN" | cmp -s - "$DUMP" \
    && [ "$(sed -n "$((7 + n))p" "$FAKE_PSQL_STDIN")" = "-- trailing note, no newline" ] \
    && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ] && [ "$(wc -l < "$FAKE_PSQL_STDIN" | tr -d ' ')" = "$((8 + n))" ]; then
    pass "(w5.1) a dump that ends in a comment without a newline still gets its COMMIT on its own line"
  else
    fail "(w5.1) no trailing newline: rc=$rc out=$out_text"
  fi
  # the same with a \unrestrict line as the last line
  { cat "$DUMP"; printf '\\unrestrict Ab1Cd2Ef3'; } > "$WORKDIR/nonl2.sql"
  run_restore -- --yes --no-pre-backup "$WORKDIR/nonl2.sql"
  if [ "$rc" -eq 0 ] && [ "$(sed -n "$((7 + n))p" "$FAKE_PSQL_STDIN")" = '\unrestrict Ab1Cd2Ef3' ] && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ]; then
    pass "(w5.2) a dump that ends in a \\unrestrict line without a newline still gets its COMMIT on its own line"
  else
    fail "(w5.2) no trailing newline after \\unrestrict: rc=$rc out=$out_text"
  fi
  # a dump that ends in a newline gets no empty line before the COMMIT
  { cat "$DUMP"; printf -- '-- trailing note\n'; } > "$WORKDIR/nl.sql"
  run_restore -- --yes --no-pre-backup "$WORKDIR/nl.sql"
  if [ "$rc" -eq 0 ] && [ "$(wc -l < "$FAKE_PSQL_STDIN" | tr -d ' ')" = "$((8 + n))" ] \
    && [ "$(sed -n "$((7 + n))p" "$FAKE_PSQL_STDIN")" = "-- trailing note" ] && [ "$(tail -n 1 "$FAKE_PSQL_STDIN")" = "COMMIT;" ]; then
    pass "(w5.3) a dump that ends in a newline gets no extra line before the COMMIT"
  else
    fail "(w5.3) trailing newline: rc=$rc"
  fi
}

# (w6) a keyword right after the end of a block comment, and after a carriage return (psql
# ends a "--" comment at a carriage return, so what follows one starts a statement); the
# message counts a carriage return as a line break, the guard line is line 52
CR=$'\r'
guard_refused "(w6.1) /**/COMMIT; is refused" '/**/COMMIT;' "$TX" 52
guard_refused "(w6.2) SELECT 1; /* c */ COMMIT; is refused" 'SELECT 1; /* c */ COMMIT;' "$TX" 52
guard_refused "(w6.3) */ COMMIT; on the line after the /* is refused" "/* c${NL}*/ COMMIT;" "$TX" 53
guard_refused "(w6.4) a -- comment ended by a carriage return, then COMMIT; is refused" "-- c${CR}COMMIT;" "$TX" 53
guard_refused "(w6.5) SELECT 1; -- x, carriage return, COMMIT; is refused" "SELECT 1; -- x${CR}COMMIT;" "$TX" 53
guard_refused "(w6.6) a carriage return before ROLLBACK alone on a line is refused" "SELECT 1;${CR}ROLLBACK" "$TX" 53
guard_refused "(w6.7) a carriage return before a \\gexec line is refused" "SELECT 1; -- c${CR}\\gexec" "$BS" 53
guard_refused "(w6.8) a carriage return before \\q is refused" "-- c${CR}\\q" "$BS" 53
guard_refused "(w6.9) a block comment then BEGIN; is refused" '/* x */ BEGIN;' "$TX" 52
guard_refused "(w6.10) a block comment closed on the line of an END; is refused" "/* a${NL}b */ END;" "$TX" 53
# a carriage return is white space for psql inside a statement: END<CR>; is one statement,
# refused by the raw-copy pass (the earlier single-pass check refused these forms too)
guard_refused "(w6.13) END, carriage return, ; is refused" "END${CR};" "$TX"
guard_refused "(w6.14) BEGIN, carriage return, ; is refused" "BEGIN${CR};" "$TX"
guard_refused "(w6.15) end, space, carriage return, ; is refused" "end ${CR};" "$TX"
guard_refused "(w6.16) END, tab, carriage return, ; is refused" "END${TAB}${CR};" "$TX"
# a carriage return alone does not refuse a dump
guard_accepted "(w6.11) a lone carriage return between plain statements is accepted" "SELECT 1;${CR}SELECT 2;"
guard_accepted "(w6.12) a keyword-looking word after a carriage return that is not a statement is accepted" "-- the end${CR}-- of the commit and begin"

# (w7) a grep that fails (here: a stub on PATH that exits 2 for one of the three greps)
# refuses the dump instead of passing it; the same dump passes with the stub idle
grep_stub_dir="$(mktemp -d "$WORKDIR/grepstub.XXXXXX")" || { echo "FAIL: could not create the grep stub directory"; exit 1; }
real_grep="$(command -v grep)"
# GREP_STUB_FAIL_MATCH: exit 2 when the arguments contain this text.
# GREP_STUB_BINARY=1: behave like a grep that takes a file with a 0xff byte for binary when it
# was not given -a (it answers "Binary file <f> matches" instead of the matching line).
cat > "$grep_stub_dir/grep" <<EOF4
#!/usr/bin/env bash
if [ -n "\${GREP_STUB_FAIL_MATCH:-}" ]; then
  case "\$*" in *"\$GREP_STUB_FAIL_MATCH"*) exit 2 ;; esac
fi
if [ -n "\${GREP_STUB_BINARY:-}" ]; then
  case " \$* " in
    *" -a "*) ;;
    *)
      for last; do :; done
      if [ -f "\$last" ] && LC_ALL=C "$real_grep" -a -q \$'\\377' "\$last"; then
        st=0
        "$real_grep" -a "\$@" > /dev/null || st=\$?
        [ "\$st" -ne 0 ] || echo "Binary file \$last matches"
        exit "\$st"
      fi
      ;;
  esac
fi
exec "$real_grep" "\$@"
EOF4
chmod +x "$grep_stub_dir/grep"
grep_stub_case() {
  guard_dump "$WORKDIR/guard.sql" "$2"
  run_restore PATH="$grep_stub_dir:$FAKE_BIN:$PATH" GREP_STUB_FAIL_MATCH="$3" -- --yes "$WORKDIR/guard.sql"
  if [ "$4" = refused ]; then
    if [ "$rc" -eq 1 ] && no_db_calls && [ ! -e "$FAKE_PSQL_STDIN" ] && grep -q -F -- "could not check" <<< "$out_text" \
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
grep_stub_case "(w7.1) the transaction control grep failing (exit 2) refuses the dump" 'SELECT 1;' '-i -E' refused "transaction control"
grep_stub_case "(w7.2) the backslash command grep failing (exit 2) refuses the dump" 'SELECT 1;' '-n -E' refused "backslash command"
grep_stub_case "(w7.3) the backslash filter grep failing (exit 2) refuses a dump that has a \\restrict line" '\restrict Ab1Cd2Ef3' '-v -E' refused "backslash command"
grep_stub_case "(w7.4) the filter grep is not run without a backslash line, so its failure does not matter (control)" 'SELECT 1;' '-v -E' accepted ""
grep_stub_case "(w7.5) the stub with no failure configured lets the dump through (control)" '\restrict Ab1Cd2Ef3' '' accepted ""

# a grep that takes a file with a high byte for binary unless given -a still yields the line
# number: the checks pass -a
grep_binary_case() {
  guard_dump "$WORKDIR/guard.sql" "$2"
  run_restore PATH="$grep_stub_dir:$FAKE_BIN:$PATH" GREP_STUB_BINARY=1 -- --yes "$WORKDIR/guard.sql"
  if [ "$rc" -eq 1 ] && no_db_calls && [ ! -e "$FAKE_PSQL_STDIN" ] && no_tmp_left \
    && grep -q -F -- "$3" <<< "$out_text" && grep -q -F -- "first at line 52," <<< "$out_text"; then
    pass "$1"
  else
    fail "$1: rc=$rc out=$out_text"
  fi
}
grep_binary_case "(w7.6) a COMMIT; line in a file with a high byte still names its line (grep given -a)" $'COMMIT;\xff' "$TX"
grep_binary_case "(w7.7) a backslash line in a file with a high byte still names its line (grep given -a)" $'\\q \xff' "$BS"

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

# (w9) bytes, not characters: under a UTF-8 locale an invalid sequence on a line must not
# hide it from the checks, nor refuse a COPY row that the byte-wise check accepts
utf8_loc="$(locale -a 2> /dev/null | grep -i -E '^(C|en_US)\.utf-?8$' | sed -n 1p || true)"
if [ -z "$utf8_loc" ]; then
  echo "NOTE: (w9) skipped, no C.UTF-8 or en_US.UTF-8 locale in 'locale -a'"
else
  guard_refused "(w9.1) COMMIT with a -- comment holding an invalid UTF-8 byte is refused under $utf8_loc" $'COMMIT -- \xff' "$TX" 52 "$utf8_loc"
  guard_refused "(w9.2) COMMIT; followed by an invalid UTF-8 byte is refused under $utf8_loc" $'COMMIT;\xff' "$TX" 52 "$utf8_loc"
  guard_refused "(w9.3) a backslash command with an invalid UTF-8 byte is refused under $utf8_loc" $'\\q \xff' "$BS" 52 "$utf8_loc"
  guard_refused "(w9.4) an invalid UTF-8 byte before a COMMIT; on the next line is refused under $utf8_loc" $'SELECT \xff;\nCOMMIT;' "$TX" 53 "$utf8_loc"
  guard_accepted "(w9.5) a COPY row that starts with \\N and has an invalid UTF-8 byte is accepted under $utf8_loc" $'COPY t (a, b) FROM stdin;\n\\N\t\xff\n\\.' "$utf8_loc"
fi

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

# (z) a TERM signal while the psql exec call runs (the COMMIT is not known yet): exit 1,
# no claim that anything was committed, no migrate or start call, no leftover copy
{
  run_restore FAKE_KILL_ON=psql -- --yes "$DUMP"
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
  run_restore FAKE_KILL_ON=run -- --yes "$DUMP"; r1=$rc
  k1=0; grep -q "committed" <<< "$out_text" && k1=1
  run_restore FAKE_KILL_ON=start -- --yes "$DUMP"; r2=$rc
  k2=0; grep -q "committed" <<< "$out_text"; k2=$?
  if [ "$r1" = 4 ] && [ "$k1" = 1 ] && [ "$r2" = 4 ] && [ "$k2" = 0 ] && grep -q "start app" <<< "$out_text" && no_tmp_left; then
    pass "(z2) signal after the COMMIT -> exit 4 saying the restore is committed (migrate and start)"
  else
    fail "(z2) signal after COMMIT: r1=$r1 k1=$k1 r2=$r2 out=$out_text"
  fi
}

# (z3) HUP and INT are handled like TERM, before and after the COMMIT
{
  run_restore FAKE_KILL_ON=psql FAKE_KILL_SIGNAL=HUP -- --yes "$DUMP"; r1=$rc
  run_restore FAKE_KILL_ON=psql FAKE_KILL_SIGNAL=INT -- --yes "$DUMP"; r2=$rc
  run_restore FAKE_KILL_ON=run FAKE_KILL_SIGNAL=HUP -- --yes "$DUMP"; r3=$rc
  k3=0; grep -q "committed" <<< "$out_text" && k3=1
  run_restore FAKE_KILL_ON=run FAKE_KILL_SIGNAL=INT -- --yes "$DUMP"; r4=$rc
  if [ "$r1" = 1 ] && [ "$r2" = 1 ] && [ "$r3" = 4 ] && [ "$k3" = 1 ] && [ "$r4" = 4 ]; then
    pass "(z3) HUP and INT exit 1 before the COMMIT and 4 with the committed message after it"
  else
    fail "(z3) HUP/INT: r1=$r1 r2=$r2 r3=$r3 k3=$k3 r4=$r4"
  fi
}

echo "restore tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
