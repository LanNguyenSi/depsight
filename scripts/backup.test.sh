#!/usr/bin/env bash
# Test driver for scripts/backup.sh. A fake `docker` on PATH stands in for compose,
# so no container or Postgres is needed. Run directly or from CI:
#   bash scripts/backup.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

# Never run the script under test against the real HOME.
export HOME="$WORKDIR/home"
mkdir -p "$HOME"

export FAKE_DOCKER_LOG="$WORKDIR/docker.log"
COMPOSE_FILE="$WORKDIR/compose.yml"
: > "$COMPOSE_FILE"

fail_count=0
pass_count=0
pass() { pass_count=$((pass_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); echo "FAIL: $1"; }

# A realistic pg_dump tail: the completion marker is followed by the \unrestrict
# block newer pg_dump versions emit, so a fixed tail window would miss it.
valid_dump_body() {
  printf -- '-- PostgreSQL database dump\n'
  for i in $(seq 1 50); do printf -- 'INSERT INTO t VALUES (%d);\n' "$i"; done
  printf -- '-- PostgreSQL database dump complete\n--\n\n'
  printf -- '\\unrestrict deadbeef1234567890abcdef1234567890abcdef1234567890abcdef1234\n\n'
}
valid_dump_body > "$WORKDIR/valid_dump.sql"

# Fake docker. FAKE_RUNNING lists the running compose services, FAKE_MODE picks
# what `exec ... pg_dump` does. Every call is logged.
cat > "$FAKE_BIN/docker" <<EOF2
#!/usr/bin/env bash
echo "\$*" >> "\$FAKE_DOCKER_LOG"
case "\$*" in
  *" ps "*) [ "\${FAKE_PS_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' \${FAKE_RUNNING:-app db}; exit 0 ;;
  *" exec "*pg_dump*)
    case "\${FAKE_MODE:-valid}" in
      valid) cat "$WORKDIR/valid_dump.sql" ;;
      fail) echo "pg_dump: fatal error" >&2; exit 1 ;;
      empty) exit 0 ;;
      tiny) echo "-- PostgreSQL database dump complete" ;;
      marker_in_row) printf -- '-- PostgreSQL database dump\\n'; for i in \$(seq 1 80); do printf -- 'INSERT INTO t VALUES (%d);\\n' "\$i"; done; printf -- 'x -- PostgreSQL database dump complete\\n' ;;
      no_marker) printf -- '-- PostgreSQL database dump\n'; for i in \$(seq 1 80); do printf -- 'INSERT INTO t VALUES (%d);\n' "\$i"; done ;;
      partial_fail) head -c 600 "$WORKDIR/valid_dump.sql"; exit 1 ;;
    esac ;;
  *) echo "fake docker: unexpected call: \$*" >&2; exit 9 ;;
esac
EOF2
chmod +x "$FAKE_BIN/docker"

# `date` is fixed when FAKE_DATE is set (to force two runs into the same second).
REAL_DATE="$(command -v date)"
cat > "$FAKE_BIN/date" <<EOF3
#!/usr/bin/env bash
if [ -n "\${FAKE_DATE:-}" ]; then echo "\$FAKE_DATE"; else exec "$REAL_DATE" "\$@"; fi
EOF3
chmod +x "$FAKE_BIN/date"

# run_backup <dir> [VAR=value ...]; sets rc, out_text
run_backup() {
  local dir="$1"; shift
  : > "$FAKE_DOCKER_LOG"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$dir" BACKUP_COMPOSE_FILE="$COMPOSE_FILE" "$@" "$BACKUP_SCRIPT" 2>&1)" || rc=$?
}
count_sql() { find "$1" -maxdepth 1 -name 'depsight-*.sql' | wc -l | tr -d ' '; }
count_tmp() { find "$1" -maxdepth 1 -name '.*.tmp' | wc -l | tr -d ' '; }

# (a) success: published, mode 600/700, exact command line, content intact
{
  d="$WORKDIR/a"
  run_backup "$d"
  f="$(find "$d" -maxdepth 1 -name 'depsight-*.sql' | head -1)"
  mode_f="$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")"
  mode_d="$(stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d")"
  if [ "$rc" -eq 0 ] && [ "$(count_sql "$d")" = 1 ] && [ "$(count_tmp "$d")" = 0 ] \
    && cmp -s "$f" "$WORKDIR/valid_dump.sql" && [ "$mode_f" = 600 ] && [ "$mode_d" = 700 ] \
    && grep -q "compose -f $COMPOSE_FILE exec -T db pg_dump --clean --if-exists -U depsight depsight" "$FAKE_DOCKER_LOG"; then
    pass "(a) success: dump published with 600/700 modes and the expected pg_dump call"
  else
    fail "(a) success: rc=$rc files=$(count_sql "$d") modes=$mode_f/$mode_d"
  fi
}

# (b) db service not running -> exit 2, no pg_dump call, nothing written
{
  d="$WORKDIR/b"
  run_backup "$d" FAKE_RUNNING=app
  if [ "$rc" -eq 2 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG" && [ ! -d "$d" ] && grep -q "not running" <<< "$out_text"; then
    pass "(b) db not running -> exit 2, no dump attempted"
  else
    fail "(b) db not running: rc=$rc"
  fi
}

# (b2) a service whose name only contains "db" is not the db service
{
  d="$WORKDIR/b2"
  run_backup "$d" FAKE_RUNNING="app mydb"
  if [ "$rc" -eq 2 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG"; then
    pass "(b2) service name must match exactly"
  else
    fail "(b2) partial service name: rc=$rc"
  fi
}

# (b3) compose ps itself fails -> exit 2
{
  d="$WORKDIR/b3"
  run_backup "$d" FAKE_PS_FAIL=1
  if [ "$rc" -eq 2 ] && ! grep -q pg_dump "$FAKE_DOCKER_LOG"; then
    pass "(b3) compose ps failure -> exit 2"
  else
    fail "(b3) compose ps failure: rc=$rc"
  fi
}

# (c) pg_dump fails -> exit 1, nothing published, no temp left
{
  d="$WORKDIR/c"
  run_backup "$d" FAKE_MODE=fail
  if [ "$rc" -eq 1 ] && [ "$(count_sql "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ]; then
    pass "(c) pg_dump failure -> exit 1, no .sql, no temp"
  else
    fail "(c) pg_dump failure: rc=$rc sql=$(count_sql "$d") tmp=$(count_tmp "$d")"
  fi
}

# (c2) pg_dump fails after writing a valid-looking prefix -> still refused
{
  d="$WORKDIR/c2"
  run_backup "$d" FAKE_MODE=partial_fail
  if [ "$rc" -eq 1 ] && [ "$(count_sql "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ]; then
    pass "(c2) failing pg_dump with partial output -> nothing published"
  else
    fail "(c2) partial failing dump: rc=$rc sql=$(count_sql "$d")"
  fi
}

# (d) validation: empty, tiny with marker, big without marker -> exit 1, nothing published
for mode in empty tiny no_marker; do
  d="$WORKDIR/d_$mode"
  run_backup "$d" FAKE_MODE="$mode"
  if [ "$rc" -eq 1 ] && [ "$(count_sql "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ]; then
    pass "(d) validation refuses mode=$mode"
  else
    fail "(d) validation mode=$mode: rc=$rc sql=$(count_sql "$d") tmp=$(count_tmp "$d")"
  fi
done

# (d2) the marker must be a whole line: the text inside a data row does not count
{
  d="$WORKDIR/d2"
  run_backup "$d" FAKE_MODE=marker_in_row
  if [ "$rc" -eq 1 ] && [ "$(count_sql "$d")" = 0 ] && [ "$(count_tmp "$d")" = 0 ]; then
    pass "(d2) completion marker inside a data row is not a marker"
  else
    fail "(d2) marker in a row: rc=$rc sql=$(count_sql "$d")"
  fi
}

# (e) rotation by count: 5 old dumps, KEEP_FILES=3 -> newest 3 remain, new dump among them
{
  d="$WORKDIR/e"; mkdir -p "$d"
  for i in 1 2 3 4 5; do
    echo old > "$d/depsight-2020010${i}_000000.sql"
    touch -t "20260101000$i" "$d/depsight-2020010${i}_000000.sql"
  done
  run_backup "$d" KEEP_FILES=3 KEEP_DAYS=36500
  left="$(find "$d" -maxdepth 1 -name 'depsight-*.sql' | wc -l | tr -d ' ')"
  if [ "$rc" -eq 0 ] && [ "$left" = 3 ] && [ ! -e "$d/depsight-20200101_000000.sql" ] \
    && [ ! -e "$d/depsight-20200102_000000.sql" ] && [ ! -e "$d/depsight-20200103_000000.sql" ] \
    && [ -e "$d/depsight-20200105_000000.sql" ] && [ -e "$d/depsight-20200104_000000.sql" ]; then
    pass "(e) rotation by count keeps the newest KEEP_FILES"
  else
    fail "(e) rotation by count: rc=$rc left=$left"
  fi
}

# (f) rotation by age: old dumps removed, the fresh one kept
{
  d="$WORKDIR/f"; mkdir -p "$d"
  echo old > "$d/depsight-20200101_000000.sql"
  touch -t 202001010000 "$d/depsight-20200101_000000.sql"
  run_backup "$d" KEEP_FILES=50 KEEP_DAYS=2
  if [ "$rc" -eq 0 ] && [ ! -e "$d/depsight-20200101_000000.sql" ] && [ "$(count_sql "$d")" = 1 ]; then
    pass "(f) rotation by age removes dumps older than KEEP_DAYS"
  else
    fail "(f) rotation by age: rc=$rc files=$(count_sql "$d")"
  fi
}

# (f2) a failed run does not rotate
{
  d="$WORKDIR/f2"; mkdir -p "$d"
  echo old > "$d/depsight-20200101_000000.sql"
  touch -t 202001010000 "$d/depsight-20200101_000000.sql"
  run_backup "$d" FAKE_MODE=no_marker KEEP_FILES=1 KEEP_DAYS=1
  if [ "$rc" -eq 1 ] && [ -e "$d/depsight-20200101_000000.sql" ]; then
    pass "(f2) failed run leaves older dumps alone"
  else
    fail "(f2) failed run rotated: rc=$rc"
  fi
}

# (g) hook success: called once with the dump path
{
  d="$WORKDIR/g"
  hook="$WORKDIR/hook_ok.sh"
  printf '#!/bin/sh\necho "$@" > "%s/hook_args"\n' "$WORKDIR" > "$hook"; chmod +x "$hook"
  run_backup "$d" BACKUP_OFFHOST_HOOK="$hook"
  f="$(find "$d" -maxdepth 1 -name 'depsight-*.sql' | head -1)"
  if [ "$rc" -eq 0 ] && [ "$(cat "$WORKDIR/hook_args")" = "$f" ]; then
    pass "(g) off-host hook receives the dump path"
  else
    fail "(g) hook success: rc=$rc args=$(cat "$WORKDIR/hook_args" 2>/dev/null)"
  fi
}

# (h) hook failure: exit 3, dump kept, rotation skipped
{
  d="$WORKDIR/h"; mkdir -p "$d"
  echo old > "$d/depsight-20200101_000000.sql"
  touch -t 202001010000 "$d/depsight-20200101_000000.sql"
  hook="$WORKDIR/hook_fail.sh"
  printf '#!/bin/sh\nexit 7\n' > "$hook"; chmod +x "$hook"
  run_backup "$d" BACKUP_OFFHOST_HOOK="$hook" KEEP_FILES=1 KEEP_DAYS=1
  if [ "$rc" -eq 3 ] && [ "$(count_sql "$d")" = 2 ] && [ -e "$d/depsight-20200101_000000.sql" ]; then
    pass "(h) hook failure -> exit 3, dump kept, rotation skipped"
  else
    fail "(h) hook failure: rc=$rc files=$(count_sql "$d")"
  fi
}

# (i) hook configured but not an executable file -> exit 2 before any docker call
{
  d="$WORKDIR/i"
  : > "$WORKDIR/not_exec.sh"
  run_backup "$d" BACKUP_OFFHOST_HOOK="$WORKDIR/not_exec.sh"
  if [ "$rc" -eq 2 ] && [ ! -s "$FAKE_DOCKER_LOG" ]; then
    pass "(i) non-executable hook -> exit 2 before docker"
  else
    fail "(i) non-executable hook: rc=$rc"
  fi
}

# (j) bad configuration: compose file missing, non-numeric / zero KEEP_*
{
  d="$WORKDIR/j"
  run_backup "$d" BACKUP_COMPOSE_FILE="$WORKDIR/missing.yml"
  r1=$rc
  run_backup "$d" KEEP_FILES=abc; r2=$rc
  run_backup "$d" KEEP_DAYS=0; r3=$rc
  if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ] && [ ! -d "$d" ]; then
    pass "(j) bad configuration -> exit 2, nothing written"
  else
    fail "(j) bad configuration: $r1 $r2 $r3"
  fi
}

# (j2) an empty KEEP_FILES / KEEP_DAYS is the same as unset: the default (14) applies
{
  d="$WORKDIR/j2"; mkdir -p "$d"
  for i in $(seq 1 16); do
    n="$(printf '%02d' "$i")"
    echo old > "$d/depsight-202001${n}_000000.sql"
    touch -t "$(date +%Y%m%d)00$n" "$d/depsight-202001${n}_000000.sql"
  done
  run_backup "$d" KEEP_FILES= KEEP_DAYS=
  if [ "$rc" -eq 0 ] && [ "$(count_sql "$d")" = 14 ]; then
    pass "(j2) empty KEEP_FILES/KEEP_DAYS fall back to 14"
  else
    fail "(j2) empty KEEP_*: rc=$rc files=$(count_sql "$d")"
  fi
}

# (k) stale temp files older than a day are reaped, fresh ones are not
{
  d="$WORKDIR/k"; mkdir -p "$d"
  : > "$d/.depsight-old.1.sql.tmp"; touch -t 202001010000 "$d/.depsight-old.1.sql.tmp"
  : > "$d/.depsight-new.2.sql.tmp"
  run_backup "$d"
  if [ "$rc" -eq 0 ] && [ ! -e "$d/.depsight-old.1.sql.tmp" ] && [ -e "$d/.depsight-new.2.sql.tmp" ]; then
    pass "(k) stale temp files are reaped"
  else
    fail "(k) stale temp files: rc=$rc"
  fi
}

# (l) BACKUP_SKIP_ROTATION: the dump is written, nothing is rotated away
{
  d="$WORKDIR/l"; mkdir -p "$d"
  for i in 1 2 3; do
    echo old > "$d/depsight-2020010${i}_000000.sql"
    touch -t "20200101000$i" "$d/depsight-2020010${i}_000000.sql"
  done
  run_backup "$d" KEEP_FILES=1 KEEP_DAYS=1 BACKUP_SKIP_ROTATION=1
  if [ "$rc" -eq 0 ] && [ "$(count_sql "$d")" = 4 ]; then
    pass "(l) BACKUP_SKIP_ROTATION keeps every dump"
  else
    fail "(l) skip rotation: rc=$rc files=$(count_sql "$d")"
  fi
}

# (m) two runs in the same second do not overwrite each other
{
  d="$WORKDIR/m"
  run_backup "$d" FAKE_DATE=20300101_000000; r1=$rc
  run_backup "$d" FAKE_DATE=20300101_000000; r2=$rc
  if [ "$r1" = 0 ] && [ "$r2" = 0 ] && [ "$(count_sql "$d")" = 2 ] && [ -e "$d/depsight-20300101_000000.sql" ]; then
    pass "(m) same-second runs keep both dumps"
  else
    fail "(m) same second: $r1 $r2 files=$(count_sql "$d")"
  fi
}

# (n) BACKUP_DIR inside the checkout but outside backups/ -> exit 2 before docker,
#     nothing created; backups/ itself and a directory outside the checkout are fine
{
  repo="$(cd "$SCRIPT_DIR/.." && pwd)"
  stray="$repo/.backup-test-stray-$$"
  run_backup "$stray"; r1=$rc; created=0; [ -e "$stray" ] && created=1; docker_used=0; [ -s "$FAKE_DOCKER_LOG" ] && docker_used=1
  run_backup "$repo/backups/../.backup-test-stray-$$"; r2=$rc
  run_backup "$repo/.backup-test-stray-$$/deeper"; r3=$rc
  link="$WORKDIR/link_into_repo"; ln -s "$repo" "$link"
  run_backup "$link/.backup-test-stray-$$"; r4=$rc
  had_backups=0; [ -e "$repo/backups" ] && had_backups=1
  sub="$repo/backups/.backup-test-$$"
  run_backup "$sub"; r5=$rc; sub_files="$(count_sql "$sub")"
  rm -rf "$stray" "$sub"; [ "$had_backups" = 1 ] || rmdir "$repo/backups" 2>/dev/null || true
  run_backup "$WORKDIR/outside"; r6=$rc
  if [ "$r1" = 2 ] && [ "$created" = 0 ] && [ "$docker_used" = 0 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ] && [ "$r4" = 2 ] \
    && [ "$r5" = 0 ] && [ "$sub_files" = 1 ] && [ "$r6" = 0 ]; then
    pass "(n) BACKUP_DIR inside the checkout is refused unless it is backups/"
  else
    fail "(n) BACKUP_DIR in checkout: $r1 created=$created docker=$docker_used $r2 $r3 $r4 backups/=$r5/$sub_files outside=$r6"
  fi
}

echo "backup tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
