#!/usr/bin/env bash
# Refuse to act on a compose project that was created from another compose file.
#
# Both production files (docker-compose.yml, the self-hosting file, and
# docker-compose.traefik.yml, the hosted file) pin `name: depsight`, so on one host
# they address the SAME compose project: `docker compose -f docker-compose.yml up`
# on a host whose stack came from the traefik file recreates the live containers
# without their Traefik labels and networks, and `down` removes them. The command
# must therefore check, before it changes anything, which file the running
# containers were created from. Docker records it: every container carries the
# label com.docker.compose.project.config_files (the files given with -f, as
# absolute paths, comma separated).
#
# Usage:   scripts/check-running-stack.sh <compose-file>
#          (called by `make prod`, `make prod-down`, scripts/backup.sh and
#          scripts/restore.sh before they touch anything)
#
# How it decides:
#   - The containers examined are the running ones that `docker compose -f <file> ps -q`
#     lists, so the project name is exactly the one compose itself resolves for that
#     file (-p, COMPOSE_PROJECT_NAME from the environment or .env, the file's `name:`):
#     a COMPOSE_PROJECT_NAME that points at another project means nothing of the
#     other stack is hit and nothing is refused.
#   - No running container: nothing to hit, passes (a first start, or a stack that
#     is down).
#   - Every examined container must list <file> among its config_files, compared by
#     base name (the checkout may have moved since the stack was created; the two
#     files have different names). Any container created from other files only is a
#     mismatch: refused, naming the files it came from.
#   - A container without the label (a compose too old to write it) cannot be
#     attributed to a file: refused too, because the commands guarded here are
#     destructive; the override below is the way through.
#   - `docker compose ps` or `docker inspect` failing is refused: an unanswered
#     question is not a yes. (docker-compose.yml needs POSTGRES_PASSWORD from .env
#     to be read at all; without it `make prod` fails by itself too.)
#
# Environment:
#   COMPOSE_GUARD_FORCE  set to a non-empty value to skip the check (a note goes to
#                        stderr). `make` maps FORCE=1 to it, for example
#                        `make prod FORCE=1`. Use it only when you really mean to
#                        run the file against that project.
#
# Exit codes:
#   0  nothing running, or every running container came from <file>, or the check
#      was skipped by COMPOSE_GUARD_FORCE
#   2  refused (mismatch, unattributable container, docker could not be asked) or
#      bad usage
set -euo pipefail

refuse() { echo "compose guard: $*" >&2; exit 2; }

[ "$#" -eq 1 ] && [ -n "$1" ] || refuse "usage: check-running-stack.sh <compose-file>"
file="$1"
[ -f "$file" ] || refuse "compose file not found: $file"
want="$(basename -- "$file")"

if [ -n "${COMPOSE_GUARD_FORCE:-}" ]; then
  echo "compose guard: check skipped (COMPOSE_GUARD_FORCE is set); $want is run against whatever is running" >&2
  exit 0
fi

ids="$(docker compose -f "$file" ps -q)" \
  || refuse "docker compose could not list the running containers of $file (see the error above); nothing was changed. Set COMPOSE_GUARD_FORCE=1 to skip this check"

while IFS= read -r id; do
  [ -n "$id" ] || continue
  line="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id")" \
    || refuse "docker inspect failed for container $id; nothing was changed. Set COMPOSE_GUARD_FORCE=1 to skip this check"
  project="${line%% *}"
  files="${line#* }"
  if [ -z "$files" ]; then
    refuse "a running container of project '$project' has no com.docker.compose.project.config_files label (written by compose 2.x; an older compose does not), so it cannot be attributed to a compose file; refusing to run $want against it. Set COMPOSE_GUARD_FORCE=1 if you know it belongs to $want"
  fi
  found=0
  live=""
  IFS=',' read -r -a paths <<< "$files"
  for p in "${paths[@]}"; do
    b="$(basename -- "$p")"
    [ "$b" != "$want" ] || found=1
    live="${live:+$live, }$b"
  done
  if [ "$found" -eq 0 ]; then
    refuse "the running containers of project '$project' were created from $live, not from $want; a command for $want would recreate or remove them (both files use the project name 'depsight'). Nothing was changed. Run the command against the stack that is running: docker compose -f $live <up -d | down | ...> (scripts/backup.sh and scripts/restore.sh: BACKUP_COMPOSE_FILE=$live). Set COMPOSE_GUARD_FORCE=1 (make: FORCE=1) only if you mean to replace that stack with $want"
  fi
done <<< "$ids"
