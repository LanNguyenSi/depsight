#!/usr/bin/env bash
# Test driver for scripts/restore.sh with a fake `docker` on PATH.
#   bash scripts/restore.test.sh
set -euo pipefail

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
case "\$*" in
  *" ps "*) [ "\${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' \${FAKE_RUNNING:-app db}; exit 0 ;;
  *" exec "*pg_dump*)
    [ "\${FAKE_PGDUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: fatal error" >&2; exit 1; }
    cat "$DUMP"; exit 0 ;;
  *" exec "*psql*)
    cat > "\$FAKE_PSQL_STDIN"
    [ "\${FAKE_PSQL_FAIL:-0}" = 1 ] && { echo "psql: ERROR" >&2; exit 3; }
    exit 0 ;;
  *" stop "*) [ "\${FAKE_STOP_FAIL:-0}" = 1 ] && { echo "stop: error" >&2; exit 5; }; exit 0 ;;
  *" start "*) [ "\${FAKE_START_FAIL:-0}" = 1 ] && { echo "start: error" >&2; exit 5; }; exit 0 ;;
  *" run "*) [ "\${FAKE_MIGRATE_FAIL:-0}" = 1 ] && { echo "migrate: error" >&2; exit 5; }; exit 0 ;;
  *) echo "fake docker: unexpected call: \$*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# run_restore [VAR=value ...] -- args...; sets rc, out_text
run_restore() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN"; rm -rf "$BACKUPS"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DIR="$BACKUPS" ${envs[@]+"${envs[@]}"} "$RESTORE_SCRIPT" "$@" 2>&1)" || rc=$?
}
no_db_calls() { ! grep -q -E ' (exec|stop|start|run) ' "$FAKE_DOCKER_LOG"; }
line_of() { grep -n -- "$1" "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1; }
count_dumps() { find "$BACKUPS" -maxdepth 1 -name 'depsight-*.sql' 2>/dev/null | wc -l | tr -d ' '; }
# the stdin psql saw must be the schema reset followed by the dump, byte for byte
stdin_is_reset_plus_dump() {
  local n; n="$(wc -l < "$DUMP" | tr -d ' ')"
  [ "$(sed -n 2p "$FAKE_PSQL_STDIN")" = "DROP SCHEMA public CASCADE;" ] \
    && grep -q '^CREATE SCHEMA public AUTHORIZATION pg_database_owner;$' "$FAKE_PSQL_STDIN" \
    && grep -q '^GRANT USAGE ON SCHEMA public TO PUBLIC;$' "$FAKE_PSQL_STDIN" \
    && tail -n "$n" "$FAKE_PSQL_STDIN" | cmp -s - "$DUMP"
}

# (a) success: stop app, pre-restore dump, schema reset + dump in one transaction, migrate, start app
{
  run_restore -- --yes "$DUMP"
  l_stop="$(line_of ' stop app')"; l_dump="$(line_of ' pg_dump ')"; l_psql="$(line_of 'psql -v ON_ERROR_STOP=1')"
  l_mig="$(line_of ' run --rm -T --build migrate')"; l_start="$(line_of ' start app')"
  if [ "$rc" -eq 0 ] && stdin_is_reset_plus_dump \
    && grep -q "exec -T db psql -v ON_ERROR_STOP=1 --single-transaction -q -U depsight -d depsight" "$FAKE_DOCKER_LOG" \
    && [ "$l_stop" -lt "$l_dump" ] && [ "$l_dump" -lt "$l_psql" ] && [ "$l_psql" -lt "$l_mig" ] && [ "$l_mig" -lt "$l_start" ] \
    && [ "$(count_dumps)" = 1 ]; then
    pass "(a) success: stop app, pre-backup, reset + dump, migrate, start app, in that order"
  else
    fail "(a) success: rc=$rc order=$l_stop,$l_dump,$l_psql,$l_mig,$l_start dumps=$(count_dumps)"
  fi
}

# (a2) --no-pre-backup: no pg_dump call, no backup directory
{
  run_restore -- --yes --no-pre-backup "$DUMP"
  if [ "$rc" -eq 0 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG" && [ ! -e "$BACKUPS" ] && stdin_is_reset_plus_dump; then
    pass "(a2) --no-pre-backup skips the pre-restore dump"
  else
    fail "(a2) no pre-backup: rc=$rc"
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
    && grep -q "still stopped" <<< "$out_text" && grep -q "start app" <<< "$out_text"; then
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

echo "restore tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
