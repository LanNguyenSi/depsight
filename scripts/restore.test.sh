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

cat > "$FAKE_BIN/docker" <<'EOF2'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" ps "*) [ "${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' ${FAKE_RUNNING:-app db}; exit 0 ;;
  *" exec "*psql*)
    cat > "$FAKE_PSQL_STDIN"
    [ "${FAKE_PSQL_FAIL:-0}" = 1 ] && { echo "psql: ERROR" >&2; exit 3; }
    exit 0 ;;
  *" stop "*|*" start "*) exit 0 ;;
  *) echo "fake docker: unexpected call: $*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# run_restore [VAR=value ...] -- args...; sets rc, out_text
run_restore() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$FAKE_DOCKER_LOG"; rm -f "$FAKE_PSQL_STDIN"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" ${envs[@]+"${envs[@]}"} "$RESTORE_SCRIPT" "$@" 2>&1)" || rc=$?
}
no_db_calls() { ! grep -q -E ' (exec|stop|start) ' "$FAKE_DOCKER_LOG"; }

# (a) success: app stopped, psql fed the dump with the safe options, app started again
{
  run_restore -- --yes "$DUMP"
  stop_line="$(grep -n ' stop app' "$FAKE_DOCKER_LOG" | cut -d: -f1)"
  psql_line="$(grep -n ' exec ' "$FAKE_DOCKER_LOG" | cut -d: -f1)"
  start_line="$(grep -n ' start app' "$FAKE_DOCKER_LOG" | cut -d: -f1)"
  if [ "$rc" -eq 0 ] && cmp -s "$DUMP" "$FAKE_PSQL_STDIN" \
    && grep -q "exec -T db psql -v ON_ERROR_STOP=1 --single-transaction -q -U depsight -d depsight" "$FAKE_DOCKER_LOG" \
    && [ "$stop_line" -lt "$psql_line" ] && [ "$psql_line" -lt "$start_line" ]; then
    pass "(a) success: stop app, psql single transaction, start app"
  else
    fail "(a) success: rc=$rc"
  fi
}

# (b) flag order does not matter
{
  run_restore -- "$DUMP" --yes
  if [ "$rc" -eq 0 ] && cmp -s "$DUMP" "$FAKE_PSQL_STDIN"; then pass "(b) --yes after the file works"; else fail "(b) flag order: rc=$rc"; fi
}

# (c) no confirmation -> exit 2, nothing touched
{
  run_restore -- "$DUMP"
  if [ "$rc" -eq 2 ] && no_db_calls && [ ! -e "$FAKE_PSQL_STDIN" ] && grep -q -- "--yes" <<< "$out_text"; then
    pass "(c) without --yes: refused, database untouched"
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
  if [ "$rc" -eq 1 ] && ! grep -q ' start app' "$FAKE_DOCKER_LOG" && grep -q "still stopped" <<< "$out_text"; then
    pass "(i) psql failure -> exit 1, app left stopped"
  else
    fail "(i) psql failure: rc=$rc"
  fi
}

# (j) app not running: no stop, no start
{
  run_restore FAKE_RUNNING=db -- --yes "$DUMP"
  if [ "$rc" -eq 0 ] && ! grep -q -E ' (stop|start) ' "$FAKE_DOCKER_LOG"; then pass "(j) app not running: not stopped, not started"; else fail "(j) app not running: rc=$rc"; fi
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

echo "restore tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
