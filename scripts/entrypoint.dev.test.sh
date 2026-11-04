#!/usr/bin/env bash
# Test driver for docker/entrypoint.dev.sh. Stub `npm`, `npx` and `sh` on PATH
# stand in for the real tools, so no install, no database and no dev server is
# involved: every stub logs one line per call with the arguments marked, which is
# what the assertions read. Run directly or from CI:
#   bash scripts/entrypoint.dev.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/../docker/entrypoint.dev.sh"
REAL_SH="$(command -v sh)"

# TMPDIR is honoured so the driver also runs where the default temp dir is not
# writable. The path echoed here is the one the trap removes.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/entrypoint.dev.test.XXXXXX")"
echo "work dir: $WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
export STUB_LOG="$WORKDIR/calls.log"

# The body of every stub, inserted into the heredocs below. A stub logs one line
# CALL [name] [arg1] [arg2] ... (its own file name first), so an argument that
# contains a space stays inside one pair of brackets and a split argument becomes
# two. The single quotes keep the expansions verbatim so they run in the generated
# stub, not here.
# shellcheck disable=SC2016
log_line='printf "CALL [${0##*/}]"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"'

cat > "$FAKE_BIN/npm" <<EOF2
#!/bin/sh
{ $log_line; } >> "\$STUB_LOG"
exit 0
EOF2

cat > "$FAKE_BIN/npx" <<EOF2
#!/bin/sh
{ $log_line; } >> "\$STUB_LOG"
exit 0
EOF2

# The `sh` stub always logs the arguments it was execed with. It runs them only
# when FAKE_SH_RUN=1, so a test can either check the argument vector alone or
# let the command really run against the npm and npx stubs.
cat > "$FAKE_BIN/sh" <<EOF3
#!/bin/sh
{ $log_line; } >> "\$STUB_LOG"
if [ "\${FAKE_SH_RUN:-0}" = 1 ]; then exec "$REAL_SH" "\$@"; fi
exit 0
EOF3

chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/npx" "$FAKE_BIN/sh"

fail_count=0
pass_count=0
pass() { pass_count=$((pass_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); echo "FAIL: $1"; }

# run_entrypoint [VAR=value ...] -- [entrypoint arguments ...]
run_entrypoint() {
  local env_extra=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do env_extra+=("$1"); shift; done
  shift
  : > "$STUB_LOG"
  rc=0
  out_text="$(env PATH="$FAKE_BIN:$PATH" ${env_extra[@]+"${env_extra[@]}"} \
    "$REAL_SH" "$ENTRYPOINT" "$@" 2>&1)" || rc=$?
}

# one call: "npm" "run" "dev" matches the log line CALL [npm] [run] [dev]
fmt_call() {
  local s="CALL" a
  for a in "$@"; do s="$s [$a]"; done
  printf '%s\n' "$s"
}
call_at() { local n="$1"; shift; [ "$(sed -n "${n}p" "$STUB_LOG")" = "$(fmt_call "$@")" ]; }
has_call() { grep -Fxq -- "$(fmt_call "$@")" "$STUB_LOG"; }
last_call_is() { [ "$(tail -1 "$STUB_LOG")" = "$(fmt_call "$@")" ]; }

# (a) no arguments (docker compose up): setup, then the dev server
{
  run_entrypoint --
  if [ "$rc" -eq 0 ] \
    && call_at 1 npm install \
    && call_at 2 npx prisma generate \
    && call_at 3 npm run db:push -- --skip-generate \
    && last_call_is npm run dev \
    && grep -q "Starting dev server" <<< "$out_text"; then
    pass "(a) no arguments: setup then exec npm run dev"
  else
    fail "(a) no arguments: rc=$rc calls=[$(tr '\n' '|' < "$STUB_LOG")] out=[$out_text]"
  fi
}

# (b) arguments (docker compose run --rm app npm test, make test): setup, then the
#     command; the dev server is never started
{
  run_entrypoint -- npm test
  if [ "$rc" -eq 0 ] \
    && call_at 1 npm install \
    && call_at 2 npx prisma generate \
    && call_at 3 npm run db:push -- --skip-generate \
    && last_call_is npm test \
    && ! grep -Fxq -- "$(fmt_call npm run dev)" "$STUB_LOG" \
    && grep -q "Running command: npm test" <<< "$out_text" \
    && ! grep -q "Starting dev server" <<< "$out_text"; then
    pass "(b) npm test: setup then exec npm test, dev server never started"
  else
    fail "(b) npm test: rc=$rc calls=[$(tr '\n' '|' < "$STUB_LOG")] out=[$out_text]"
  fi
}

# (c) one argument with spaces stays one argument: make lint passes
#     sh -c 'npm run lint && npx tsc --noEmit', so the entrypoint must exec sh with
#     exactly two arguments (the stub does not run them, only the vector is checked)
{
  run_entrypoint -- sh -c 'npm run lint && npx tsc --noEmit'
  if [ "$rc" -eq 0 ] && last_call_is sh -c 'npm run lint && npx tsc --noEmit' \
    && ! grep -Fxq -- "$(fmt_call npm run dev)" "$STUB_LOG"; then
    pass "(c) argument with spaces reaches the exec as one argument"
  else
    fail "(c) spaced argument: rc=$rc calls=[$(tr '\n' '|' < "$STUB_LOG")]"
  fi
}

# (c2) and the same command really runs as written: sh -c 'echo a b' prints a b, and
#     the Makefile lint command reaches npm and tsc with their own arguments
{
  run_entrypoint FAKE_SH_RUN=1 -- sh -c 'echo a b'
  if [ "$rc" -eq 0 ] && [ "$(tail -1 <<< "$out_text")" = "a b" ]; then
    pass "(c2) sh -c 'echo a b' runs and prints a b"
  else
    fail "(c2) echo a b: rc=$rc out=[$out_text]"
  fi

  run_entrypoint FAKE_SH_RUN=1 -- sh -c 'npm run lint && npx tsc --noEmit'
  if [ "$rc" -eq 0 ] \
    && has_call sh -c 'npm run lint && npx tsc --noEmit' \
    && has_call npm run lint \
    && has_call npx tsc --noEmit \
    && ! grep -Fxq -- "$(fmt_call npm run dev)" "$STUB_LOG"; then
    pass "(c2) make lint's command runs as npm run lint and npx tsc --noEmit"
  else
    fail "(c2) make lint shape: rc=$rc calls=[$(tr '\n' '|' < "$STUB_LOG")]"
  fi
}

# (d) a failing command ends the entrypoint with its exit status (make ci must fail)
{
  cat > "$FAKE_BIN/false" <<EOF4
#!/bin/sh
{ $log_line; } >> "\$STUB_LOG"
exit 5
EOF4
  chmod +x "$FAKE_BIN/false"
  run_entrypoint -- false
  if [ "$rc" -eq 5 ] && last_call_is false; then
    pass "(d) the command's exit status is the entrypoint's"
  else
    fail "(d) exit status: rc=$rc"
  fi
}

# (e) one argument is a command too: the branch compares the count to zero, not to one
{
  run_entrypoint -- sh
  if [ "$rc" -eq 0 ] && last_call_is sh \
    && ! grep -Fxq -- "$(fmt_call npm run dev)" "$STUB_LOG"; then
    pass "(e) a single argument takes the command branch"
  else
    fail "(e) single argument: rc=$rc calls=[$(tr '\n' '|' < "$STUB_LOG")]"
  fi
}

# (f) only zero arguments mean "start the dev server": one empty argument is a
#     command that cannot run, so the entrypoint fails instead of serving
{
  run_entrypoint -- ''
  if [ "$rc" -ne 0 ] \
    && call_at 3 npm run db:push -- --skip-generate \
    && ! grep -Fxq -- "$(fmt_call npm run dev)" "$STUB_LOG" \
    && ! grep -q "Starting dev server" <<< "$out_text"; then
    pass "(f) an empty argument does not fall back to the dev server"
  else
    fail "(f) empty argument: rc=$rc calls=[$(tr '\n' '|' < "$STUB_LOG")] out=[$out_text]"
  fi
}

echo "entrypoint.dev tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
