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
  # scripts/check-running-stack.sh: the containers of the project (FAKE_IDS, none by
  # default) and the compose labels of each (FAKE_INSPECT_OUT: "<project> <config_files>")
  # ps -a -q lists every container of the project, ps -q only the running ones (FAKE_IDS);
  # FAKE_STOPPED_IDS are the stopped ones
  *" ps -a -q") [ "\${FAKE_PSQ_FAIL:-0}" = 1 ] && exit 1; for id in \${FAKE_IDS:-} \${FAKE_STOPPED_IDS:-}; do echo "\$id"; done; exit 0 ;;
  *" ps -q") [ "\${FAKE_PSQ_FAIL:-0}" = 1 ] && exit 1; for id in \${FAKE_IDS:-}; do echo "\$id"; done; exit 0 ;;
  inspect\ *) [ "\${FAKE_INSPECT_FAIL:-0}" = 1 ] && exit 1; var="FAKE_INSPECT_OUT_\${*: -1}"; printf '%s\n' "\${!var:-\${FAKE_INSPECT_OUT:-}}"; exit 0 ;;
  # make prod / prod-down reach the stub only after the guard let them through
  *" up "*|*" down") exit 0 ;;
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

# (o) BACKUP_COMPOSE_FILE precedence, with the variable truly absent (run_backup always
# sets it): unset and empty use the hosted docker-compose.traefik.yml of the checkout, a
# non-empty value (the self-hosting docker-compose.yml) wins
{
  repo="$(cd "$SCRIPT_DIR/.." && pwd)"
  SELF_COMPOSE="$WORKDIR/docker-compose.yml"; : > "$SELF_COMPOSE"
  used_files() { grep -o -- 'compose -f [^ ]*' "$FAKE_DOCKER_LOG" | sort -u | tr '\n' ' '; }
  : > "$FAKE_DOCKER_LOG"; r1=0
  env -u BACKUP_COMPOSE_FILE PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$WORKDIR/o1" "$BACKUP_SCRIPT" > /dev/null 2>&1 || r1=$?
  f1="$(used_files)"
  : > "$FAKE_DOCKER_LOG"; r2=0
  env BACKUP_COMPOSE_FILE= PATH="$FAKE_BIN:$PATH" BACKUP_DIR="$WORKDIR/o2" "$BACKUP_SCRIPT" > /dev/null 2>&1 || r2=$?
  f2="$(used_files)"
  run_backup "$WORKDIR/o3" BACKUP_COMPOSE_FILE="$SELF_COMPOSE"; r3=$rc
  f3="$(used_files)"
  if [ "$r1$r2$r3" = 000 ] \
    && [ "$f1" = "compose -f $repo/docker-compose.traefik.yml " ] \
    && [ "$f2" = "compose -f $repo/docker-compose.traefik.yml " ] \
    && [ "$f3" = "compose -f $SELF_COMPOSE " ]; then
    pass "(o) BACKUP_COMPOSE_FILE: unset and empty use the hosted file, a set value wins"
  else
    fail "(o) compose file precedence: rc=$r1/$r2/$r3 used=[$f1] [$f2] [$f3]"
  fi
}

# ---- the compose-file guard (scripts/check-running-stack.sh), on its own, in backup.sh and
# behind the make targets. The fake docker answers `compose -f <file> ps -q` with FAKE_IDS
# (default none, plus the stopped FAKE_STOPPED_IDS) and every `docker inspect` with FAKE_INSPECT_OUT ("<project> <files>").
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$SCRIPT_DIR/check-running-stack.sh"
SELF_FILE="$WORKDIR/docker-compose.yml"; : > "$SELF_FILE"
HOSTED_LABEL="depsight /srv/depsight/docker-compose.traefik.yml"
SELF_LABEL="depsight /srv/depsight/docker-compose.yml"
# run_guard [--other-prod] <file> [VAR=value ...]; sets rc, out_text
run_guard() {
  local mode=()
  if [ "$1" = --other-prod ]; then mode=(--other-prod docker-compose.traefik.yml); shift; fi
  local f="$1"; shift
  : > "$FAKE_DOCKER_LOG"
  rc=0
  # DOCKER_HOST and DOCKER_CONTEXT: a real docker reached by mistake fails closed
  out_text="$(env PATH="$FAKE_BIN:$PATH" DOCKER_HOST=unix:///nonexistent DOCKER_CONTEXT=default "$@" "$GUARD" ${mode[@]+"${mode[@]}"} "$f" 2>&1)" || rc=$?
}
no_inspect() { ! grep -q '^inspect ' "$FAKE_DOCKER_LOG"; }

# (p1) no container, running or stopped: nothing to hit, passes without asking for labels
{
  run_guard "$SELF_FILE"
  if [ "$rc" -eq 0 ] && grep -q "compose -f $SELF_FILE ps -a -q" "$FAKE_DOCKER_LOG" && no_inspect; then
    pass "(p1) guard: no container of the project passes"
  else
    fail "(p1) guard no container: rc=$rc"
  fi
}

# (p2) the running containers came from the same file
{
  run_guard "$SELF_FILE" FAKE_IDS="c1 c2" FAKE_INSPECT_OUT="$SELF_LABEL"
  if [ "$rc" -eq 0 ] && [ "$(grep -c '^inspect ' "$FAKE_DOCKER_LOG")" = 2 ]; then
    pass "(p2) guard: same compose file passes (every container inspected)"
  else
    fail "(p2) guard same file: rc=$rc"
  fi
}

# (p3) the running containers came from the other file: exit 2, the message names that file
# and the right command, nothing else is called
{
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL"
  if [ "$rc" -eq 2 ] && grep -q "created from docker-compose.traefik.yml, not from docker-compose.yml;" <<< "$out_text" \
    && grep -q "docker compose -f docker-compose.traefik.yml " <<< "$out_text" \
    && [ "$(wc -l < "$FAKE_DOCKER_LOG" | tr -d ' ')" = 2 ]; then
    pass "(p3) guard: stack from the hosted file refused for the self-hosting file (exit 2, names the live file and the command)"
  else
    fail "(p3) guard mismatch: rc=$rc out=$out_text"
  fi
}

# (p3b) the other direction: a stack from the self-hosting file, checked against the hosted file
{
  HOSTED_FILE="$WORKDIR/docker-compose.traefik.yml"; : > "$HOSTED_FILE"
  run_guard "$HOSTED_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$SELF_LABEL"
  if [ "$rc" -eq 2 ] && grep -q "created from docker-compose.yml, not from docker-compose.traefik.yml;" <<< "$out_text"; then
    pass "(p3b) guard: stack from the self-hosting file refused for the hosted file"
  else
    fail "(p3b) guard reverse mismatch: rc=$rc out=$out_text"
  fi
}

# (p3c) one matching and one mismatching container: refused (every container counts);
# FAKE_INSPECT_OUT_<id> answers for one container
{
  run_guard "$SELF_FILE" FAKE_IDS="c1 c2" FAKE_INSPECT_OUT_c1="$SELF_LABEL" FAKE_INSPECT_OUT_c2="$HOSTED_LABEL"
  r1=$rc
  run_guard "$SELF_FILE" FAKE_IDS="c1 c2" FAKE_INSPECT_OUT_c1="$HOSTED_LABEL" FAKE_INSPECT_OUT_c2="$SELF_LABEL"
  if [ "$r1" -eq 2 ] && [ "$rc" -eq 2 ]; then
    pass "(p3c) guard: a mismatch in any container's labels refuses, whichever comes first"
  else
    fail "(p3c) guard mixed: $r1/$rc"
  fi
}

# (p4) a container without the label cannot be attributed: refused with its own message
{
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight "
  if [ "$rc" -eq 2 ] && grep -q "has no com.docker.compose.project.config_files label" <<< "$out_text"; then
    pass "(p4) guard: container without the config_files label refused"
  else
    fail "(p4) guard missing label: rc=$rc out=$out_text"
  fi
}

# (p5) the override skips the check, without asking docker at all, and says so
{
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL" COMPOSE_GUARD_FORCE=1
  if [ "$rc" -eq 0 ] && [ ! -s "$FAKE_DOCKER_LOG" ] && grep -q "check skipped" <<< "$out_text"; then
    pass "(p5) guard: COMPOSE_GUARD_FORCE=1 skips the check"
  else
    fail "(p5) guard override: rc=$rc log=$(cat "$FAKE_DOCKER_LOG")"
  fi
}

# (p5b) only 1 and yes are an override: empty, 0, true and no are not
{
  rcs=""
  for v in "" 0 true no; do
    run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL" COMPOSE_GUARD_FORCE="$v"
    rcs="$rcs$rc"
  done
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL" COMPOSE_GUARD_FORCE=yes
  if [ "$rcs" = 2222 ] && [ "$rc" -eq 0 ]; then
    pass "(p5b) guard: COMPOSE_GUARD_FORCE empty, 0, true and no do not skip the check, yes does"
  else
    fail "(p5b) guard override values: $rcs / yes=$rc"
  fi
}

# (p6) default mode (backup.sh, restore.sh): a label that lists several files matches when
# the file is one of them, none matching refuses
{
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight /srv/a/docker-compose.override.yml,/srv/b/docker-compose.yml"
  r1=$rc
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight /srv/a/docker-compose.override.yml,/srv/b/docker-compose.traefik.yml"
  if [ "$r1" -eq 0 ] && [ "$rc" -eq 2 ]; then
    pass "(p6) guard: several config files match by base name, none matching refuses"
  else
    fail "(p6) guard several files: $r1/$rc"
  fi
}

# (p6b) --other-prod docker-compose.traefik.yml (what make prod and prod-down pass): a label that
# lists the target file is refused when it also lists the other production file; the same
# label passes in default mode (backup.sh, restore.sh). A stack started with the documented
# override file (docker-compose.yml plus docker-compose.override.yml) passes in both modes.
BOTH_LABEL="depsight /srv/depsight/docker-compose.yml,/srv/depsight/docker-compose.traefik.yml"
OVERRIDE_LABEL="depsight /srv/depsight/docker-compose.yml,/srv/depsight/docker-compose.override.yml"
{
  run_guard --other-prod "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$BOTH_LABEL"
  r1=$rc; o1="$out_text"
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$BOTH_LABEL"
  r2=$rc
  run_guard --other-prod "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$SELF_LABEL"
  r3=$rc
  run_guard --other-prod "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL"
  r4=$rc
  run_guard --other-prod "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$OVERRIDE_LABEL"
  r5=$rc
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$OVERRIDE_LABEL"
  r6=$rc
  if [ "$r1" -eq 2 ] && grep -q "includes the other production file docker-compose.traefik.yml" <<< "$o1" \
    && [ "$r2" -eq 0 ] && [ "$r3" -eq 0 ] && [ "$r4" -eq 2 ] && [ "$r5" -eq 0 ] && [ "$r6" -eq 0 ]; then
    pass "(p6b) guard --other-prod: a stack with both production files is refused, the same label passes in default mode, the file alone and the file with the override file pass"
  else
    fail "(p6b) guard --other-prod: $r1/$r2/$r3/$r4/$r5/$r6 $o1"
  fi
}
# (p6b2) the option needs a file name
{
  rc=0; out_text="$(env PATH="$FAKE_BIN:$PATH" "$GUARD" --other-prod 2>&1)" || rc=$?
  r1=$rc
  rc=0; out_text="$(env PATH="$FAKE_BIN:$PATH" "$GUARD" --other-prod "$SELF_FILE" 2>&1)" || rc=$?
  if [ "$r1" -eq 2 ] && [ "$rc" -eq 2 ]; then
    pass "(p6b2) guard: --other-prod without a file name or without a compose file refuses"
  else
    fail "(p6b2) guard --other-prod usage: $r1/$rc"
  fi
}

# (p6c) the hint names every live file as its own -f, and one file for BACKUP_COMPOSE_FILE
{
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight /srv/a/one.yml,/srv/b/two.yml"
  o1="$out_text"; r1=$rc
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL"
  if [ "$r1" -eq 2 ] && grep -q "docker compose -f one.yml -f two.yml <up" <<< "$o1" && ! grep -q "one.yml, two.yml <" <<< "$o1" \
    && grep -q "take one file" <<< "$o1" && grep -q "BACKUP_COMPOSE_FILE=docker-compose.traefik.yml" <<< "$out_text"; then
    pass "(p6c) guard: the command hint repeats -f per file and the scripts hint names a single file"
  else
    fail "(p6c) guard hint: $o1 // $out_text"
  fi
}

# (p6d) a stopped container counts: running ones are none, one stopped container came from
# the other file
{
  run_guard "$SELF_FILE" FAKE_STOPPED_IDS="c1" FAKE_INSPECT_OUT="$HOSTED_LABEL"
  r1=$rc
  run_guard "$SELF_FILE" FAKE_STOPPED_IDS="c1" FAKE_INSPECT_OUT="$SELF_LABEL"
  if [ "$r1" -eq 2 ] && [ "$rc" -eq 0 ] && grep -q 'ps -a -q' "$FAKE_DOCKER_LOG"; then
    pass "(p6d) guard: a stopped container of the other file is refused, one of the same file passes"
  else
    fail "(p6d) guard stopped: $r1/$rc"
  fi
}

# (p7) docker cannot be asked: refused, nothing is passed on
{
  run_guard "$SELF_FILE" FAKE_PSQ_FAIL=1
  r1=$rc
  run_guard "$SELF_FILE" FAKE_IDS="c1" FAKE_INSPECT_FAIL=1
  if [ "$r1" -eq 2 ] && [ "$rc" -eq 2 ] && grep -q "docker inspect failed" <<< "$out_text"; then
    pass "(p7) guard: a failing compose ps or inspect refuses"
  else
    fail "(p7) guard docker failure: $r1/$rc"
  fi
}

# (p8) bad usage and a missing file
{
  run_guard "$WORKDIR/no-such.yml"
  r1=$rc
  rc=0; out_text="$(env PATH="$FAKE_BIN:$PATH" "$GUARD" 2>&1)" || rc=$?
  if [ "$r1" -eq 2 ] && [ "$rc" -eq 2 ]; then
    pass "(p8) guard: missing file and missing argument refuse"
  else
    fail "(p8) guard usage: $r1/$rc"
  fi
}

# (q) backup.sh runs the guard before it writes anything. Precedence in the guard: the
# override wins over a mismatch; with no override a mismatch beats a running db service.
{
  d="$WORKDIR/q1"
  run_backup "$d" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight /srv/depsight/docker-compose.traefik.yml"
  r1=$rc; o1="$out_text"; no_dump1=1; grep -q pg_dump "$FAKE_DOCKER_LOG" && no_dump1=0
  d2="$WORKDIR/q2"
  run_backup "$d2" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight /srv/depsight/compose.yml"
  r2=$rc
  d3="$WORKDIR/q3"
  run_backup "$d3" FAKE_IDS="c1" FAKE_INSPECT_OUT="depsight /srv/depsight/docker-compose.traefik.yml" COMPOSE_GUARD_FORCE=1
  r3=$rc
  if [ "$r1" -eq 2 ] && [ "$no_dump1" = 1 ] && [ ! -d "$d" ] && grep -q "created from docker-compose.traefik.yml, not from compose.yml;" <<< "$o1" \
    && [ "$r2" -eq 0 ] && [ "$(count_sql "$d2")" = 1 ] \
    && [ "$r3" -eq 0 ] && [ "$(count_sql "$d3")" = 1 ]; then
    pass "(q) backup.sh: stack from another file refused before dumping (exit 2, no directory), same file and the override go on"
  else
    fail "(q) backup.sh guard: $r1 no_dump=$no_dump1 dir=$([ -d "$d" ] && echo yes || echo no) $r2/$r3"
  fi
}

# (r) the make targets call the guard before docker compose. The fake docker is on PATH,
# so `make prod` here changes nothing; an unexpected docker call exits 9. run_make <VAR=value ...> -- <make args>
run_make() {
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : > "$FAKE_DOCKER_LOG"
  rc=0
  # DOCKER_HOST and DOCKER_CONTEXT: a real docker reached by mistake fails closed
  out_text="$(env PATH="$FAKE_BIN:$PATH" DOCKER_HOST=unix:///nonexistent DOCKER_CONTEXT=default ${envs[@]+"${envs[@]}"} make -C "$REPO_DIR" "$@" 2>&1)" || rc=$?
}
sent_up() { grep -q 'compose -f docker-compose.yml up --build -d' "$FAKE_DOCKER_LOG"; }
sent_down() { grep -q 'compose -f docker-compose.yml down' "$FAKE_DOCKER_LOG"; }
if command -v make > /dev/null 2>&1; then
  # (r1) nothing running: the guard asks, then prod goes through; prod-down too
  run_make -- prod; a=$rc; l_ps="$(grep -n 'ps -a -q' "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true)"; l_up="$(grep -n ' up ' "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true)"
  run_make -- prod-down; b=$rc
  if [ "$a" -eq 0 ] && [ "$b" -eq 0 ] && [ -n "$l_ps" ] && [ -n "$l_up" ] && [ "$l_ps" -lt "$l_up" ] && sent_down; then
    pass "(r1) make prod and prod-down: nothing running passes, the guard runs before docker compose"
  else
    fail "(r1) make nothing running: $a/$b ps=$l_ps up=$l_up"
  fi
  # (r2) same file: passes
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="depsight /srv/depsight/docker-compose.yml" -- prod; a=$rc; up_a=0; sent_up && up_a=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="depsight /srv/depsight/docker-compose.yml" -- prod-down; b=$rc; dn_b=0; sent_down && dn_b=1
  if [ "$a" -eq 0 ] && [ "$b" -eq 0 ] && [ "$up_a" = 1 ] && [ "$dn_b" = 1 ]; then
    pass "(r2) make prod and prod-down: stack from docker-compose.yml passes"
  else
    fail "(r2) make same file: $a/$b up=$up_a down=$dn_b"
  fi
  # (r3) hosted stack: both refused, no up or down reaches docker, the message names the file
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod; a=$rc; o_a="$out_text"; up_a=0; sent_up && up_a=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod-down; b=$rc; o_b="$out_text"; dn_b=0; sent_down && dn_b=1
  if [ "$a" -ne 0 ] && [ "$b" -ne 0 ] && [ "$up_a" = 0 ] && [ "$dn_b" = 0 ] \
    && grep -q "docker compose -f docker-compose.traefik.yml" <<< "$o_a" && grep -q "docker compose -f docker-compose.traefik.yml" <<< "$o_b"; then
    pass "(r3) make prod and prod-down: hosted stack refused, no up or down sent"
  else
    fail "(r3) make hosted stack: $a/$b up=$up_a down=$dn_b"
  fi
  # (r4) the override: FORCE=1 and FORCE=yes skip the guard; FORCE=0 and an empty FORCE do not
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod FORCE=1; a=$rc; up_a=0; sent_up && up_a=1; asked_a=0; grep -q 'ps -a -q' "$FAKE_DOCKER_LOG" && asked_a=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod-down FORCE=yes; b=$rc; dn_b=0; sent_down && dn_b=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod FORCE=0; c=$rc
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod FORCE=; d=$rc
  # FORCE from the shell environment is not an override, only FORCE on the command line is
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" FORCE=1 -- prod; e=$rc; up_e=0; sent_up && up_e=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" FORCE=1 -- prod-down; f=$rc; dn_f=0; sent_down && dn_f=1
  # COMPOSE_GUARD_FORCE=0 in the environment is not an override either; =1 is
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" COMPOSE_GUARD_FORCE=0 -- prod; g=$rc
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" COMPOSE_GUARD_FORCE=1 -- prod; h=$rc
  if [ "$a" -eq 0 ] && [ "$up_a" = 1 ] && [ "$asked_a" = 0 ] && [ "$b" -eq 0 ] && [ "$dn_b" = 1 ] && [ "$c" -ne 0 ] && [ "$d" -ne 0 ] \
    && [ "$e" -ne 0 ] && [ "$up_e" = 0 ] && [ "$f" -ne 0 ] && [ "$dn_f" = 0 ] && [ "$g" -ne 0 ] && [ "$h" -eq 0 ]; then
    pass "(r4) make FORCE=1 and FORCE=yes on the command line skip the guard; FORCE=0, an empty FORCE and FORCE in the shell environment do not; COMPOSE_GUARD_FORCE=0 does not, =1 does"
  else
    fail "(r4) make FORCE: $a/$b/$c/$d/$e/$f/$g/$h up=$up_a down=$dn_b asked=$asked_a env=$up_e/$dn_f"
  fi
  # (r6) a stopped container of the hosted stack: prod and prod-down are refused too, and so is
  # a stack created from both production files; a stopped container of the same file passes
  run_make FAKE_STOPPED_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod; a=$rc; up_a=0; sent_up && up_a=1
  run_make FAKE_STOPPED_IDS=c1 FAKE_INSPECT_OUT="$HOSTED_LABEL" -- prod-down; b=$rc; dn_b=0; sent_down && dn_b=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$BOTH_LABEL" -- prod; c=$rc; up_c=0; sent_up && up_c=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$BOTH_LABEL" -- prod-down; d=$rc; dn_d=0; sent_down && dn_d=1
  run_make FAKE_STOPPED_IDS=c1 FAKE_INSPECT_OUT="depsight /srv/depsight/docker-compose.yml" -- prod; e=$rc
  # a self-host stack started with the documented override file: prod and prod-down go through
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$OVERRIDE_LABEL" -- prod; f=$rc; up_f=0; sent_up && up_f=1
  run_make FAKE_IDS=c1 FAKE_INSPECT_OUT="$OVERRIDE_LABEL" -- prod-down; g=$rc; dn_g=0; sent_down && dn_g=1
  if [ "$a" -ne 0 ] && [ "$up_a" = 0 ] && [ "$b" -ne 0 ] && [ "$dn_b" = 0 ] \
    && [ "$c" -ne 0 ] && [ "$up_c" = 0 ] && [ "$d" -ne 0 ] && [ "$dn_d" = 0 ] && [ "$e" -eq 0 ] \
    && [ "$f" -eq 0 ] && [ "$up_f" = 1 ] && [ "$g" -eq 0 ] && [ "$dn_g" = 1 ]; then
    pass "(r6) make prod and prod-down: a stopped hosted container and a stack from both production files are refused; a stopped container of docker-compose.yml and a stack with docker-compose.override.yml pass"
  else
    fail "(r6) make stopped/both/override: $a/$b/$c/$d/$e/$f/$g up=$up_a/$up_c/$up_f down=$dn_b/$dn_d/$dn_g"
  fi
  # (r5) make backup passes the guard on to backup.sh: refused on a mismatch, FORCE=1 goes on
  run_make BACKUP_DIR="$WORKDIR/r5a" FAKE_IDS=c1 FAKE_INSPECT_OUT="$SELF_LABEL" -- backup; a=$rc; dir_a=0; [ -d "$WORKDIR/r5a" ] && dir_a=1
  run_make BACKUP_DIR="$WORKDIR/r5b" FAKE_IDS=c1 FAKE_INSPECT_OUT="$SELF_LABEL" -- backup FORCE=1; b=$rc
  if [ "$a" -ne 0 ] && [ "$dir_a" = 0 ] && [ "$b" -eq 0 ] && [ "$(count_sql "$WORKDIR/r5b")" = 1 ]; then
    pass "(r5) make backup: refused on a mismatch before writing, FORCE=1 reaches backup.sh as COMPOSE_GUARD_FORCE"
  else
    fail "(r5) make backup: $a dir=$dir_a $b"
  fi
else
  echo "SKIP: (r) make is not installed"
fi

echo "backup tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
