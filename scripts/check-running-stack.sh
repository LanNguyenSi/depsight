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
# Usage:   scripts/check-running-stack.sh [--exact] <compose-file>
#          (called by `make prod`, `make prod-down`, scripts/backup.sh and
#          scripts/restore.sh before they touch anything)
#
# How it decides:
#   - The containers examined are all the containers, running or stopped, that
#     `docker compose -f <file> ps -a -q` lists. Compose resolves the project name for
#     that file: COMPOSE_PROJECT_NAME from the environment or .env, else the file's
#     `name:` (no guarded entry point passes -p). A COMPOSE_PROJECT_NAME that points at
#     another project means nothing of the other stack is hit and nothing is refused.
#     Stopped containers count: `up` would recreate them from the wrong file, `down`
#     would remove them.
#   - No container of the project, running or stopped: nothing to hit, passes (a first
#     start, or a stack that was removed).
#   - Every examined container is compared by the base names of the files in its
#     config_files label (the checkout may have moved since the stack was created; the
#     two files have different names):
#       default mode (backup.sh, restore.sh, which take one file): the label must list
#         <file>; a container created from other files only is refused.
#       --exact (make prod, make prod-down, which pin one file with -f): the label must
#         list <file> and nothing else, so a stack created from both production files
#         is refused too.
#     A refusal names the files the container came from.
#   - A container without the label (a compose too old to write it) cannot be
#     attributed to a file: refused too, because the commands guarded here are
#     destructive; the override below is the way through.
#   - `docker compose ps` or `docker inspect` failing is refused: an unanswered
#     question is not a yes. (docker-compose.yml needs POSTGRES_PASSWORD from .env
#     to be read at all; without it `make prod` fails by itself too.)
#
# Environment:
#   COMPOSE_GUARD_FORCE  `1` or `yes` skips the check (a note goes to stderr); any other
#                        value, empty included, does not. `make` maps FORCE=1 or FORCE=yes
#                        given on the make command line to it, for example
#                        `make prod FORCE=1`; a FORCE in the shell environment is ignored.
#                        Use it only when you really mean to run the file against that
#                        project.
#
# Exit codes:
#   0  nothing in the project, or every container came from <file> (alone, with
#      --exact), or the check was skipped by COMPOSE_GUARD_FORCE
#   2  refused (mismatch, unattributable container, docker could not be asked) or
#      bad usage
set -euo pipefail

refuse() { echo "compose guard: $*" >&2; exit 2; }

exact=0
if [ "${1:-}" = --exact ]; then exact=1; shift; fi
[ "$#" -eq 1 ] && [ -n "$1" ] || refuse "usage: check-running-stack.sh [--exact] <compose-file>"
file="$1"
[ -f "$file" ] || refuse "compose file not found: $file"
want="$(basename -- "$file")"

case "${COMPOSE_GUARD_FORCE:-}" in
  1|yes)
    echo "compose guard: check skipped (COMPOSE_GUARD_FORCE=$COMPOSE_GUARD_FORCE); $want is run against whatever exists in the project" >&2
    exit 0
    ;;
esac

ids="$(docker compose -f "$file" ps -a -q)" \
  || refuse "docker compose could not list the containers of $file (see the error above); nothing was changed. Set COMPOSE_GUARD_FORCE=1 to skip this check"

while IFS= read -r id; do
  [ -n "$id" ] || continue
  line="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id")" \
    || refuse "docker inspect failed for container $id; nothing was changed. Set COMPOSE_GUARD_FORCE=1 to skip this check"
  project="${line%% *}"
  files="${line#* }"
  if [ -z "$files" ]; then
    refuse "a container of project '$project' has no com.docker.compose.project.config_files label (written by compose 2.x; an older compose does not), so it cannot be attributed to a compose file; refusing to run $want against it. Set COMPOSE_GUARD_FORCE=1 if you know it belongs to $want"
  fi
  found=0
  others=0
  live_f=""
  live_names=""
  IFS=',' read -r -a paths <<< "$files"
  for p in "${paths[@]}"; do
    b="$(basename -- "$p")"
    if [ "$b" = "$want" ]; then found=1; else others=1; fi
    live_f="${live_f:+$live_f }-f $b"
    live_names="${live_names:+$live_names, }$b"
  done
  if [ "$found" -eq 0 ] || { [ "$exact" -eq 1 ] && [ "$others" -eq 1 ]; }; then
    if [ "${#paths[@]}" -eq 1 ]; then
      script_hint="BACKUP_COMPOSE_FILE=${files##*/}"
    else
      script_hint="scripts/backup.sh and scripts/restore.sh take one file: set BACKUP_COMPOSE_FILE to the one that holds the stack's services"
    fi
    refuse "the containers of project '$project' (running or stopped) were created from $live_names, not from $want alone; a command for $want would recreate or remove them (both files use the project name 'depsight'). Nothing was changed. Run the command against the stack that exists: docker compose $live_f <up -d | down | ...> ($script_hint). Set COMPOSE_GUARD_FORCE=1 (make: FORCE=1 on the command line) only if you mean to replace that stack with $want"
  fi
done <<< "$ids"
