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
