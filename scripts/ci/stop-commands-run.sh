#!/usr/bin/env bash
# Run a command with its stdout and stderr printed inside a GitHub Actions
# ::stop-commands:: block keyed by a per-run random token.
#
# npm output (install progress, registry error text, package names and
# versions) is registry-influenced. Printed raw, a line such as `::error::x`
# or `::add-mask::` in it would act as a live workflow command. Between
# `::stop-commands::<token>` and the resume line `::<token>::` the runner
# ignores workflow commands, and an attacker cannot guess the token, which is
# generated here and never taken from event data.
#
# Usage: stop-commands-run.sh <command> [args...]
# Exit status: the command's own exit status. Exit 1 (before the command
# runs, so nothing unprotected is printed) when no token can be generated.
set -u

if [ "$#" -eq 0 ]; then
  echo "stop-commands-run: no command given" >&2
  exit 2
fi

TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
# A failed od would leave an empty token, which the runner rejects without
# stopping commands: refuse to run the command (and print its output) then.
if [ "${#TOKEN}" -ne 32 ]; then
  echo "stop-commands-run: could not generate a stop-commands token" >&2
  exit 1
fi

echo "::stop-commands::$TOKEN"
"$@" 2>&1
STATUS=$?
# Leading newline: output without a trailing newline must not swallow the
# resume line.
printf '\n::%s::\n' "$TOKEN"
exit "$STATUS"
