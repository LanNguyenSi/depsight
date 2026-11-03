#!/usr/bin/env bash
# Restore a dump written by scripts/backup.sh into the running hosted stack.
#
# Usage: scripts/restore.sh --yes [--no-pre-backup] <dump.sql>
#
# DESTRUCTIVE: the whole `public` schema is dropped and recreated, then the dump is
# loaded into it. Every table, view and sequence that exists now and is not in the
# dump is gone (a table a newer release added, with a foreign key into a table the
# dump also has, included: pg_dump --clean alone cannot drop it and the restore would
# fail), and rows written after the dump are lost. Without --yes the script only says
# what it would do and exits 2; there is no interactive prompt, so a cron job or a
# pasted command cannot restore by accident.
#
# What it does, in order:
#   1. checks the file argument, copies the dump into a private temporary file inside
#      BACKUP_DIR and checks THAT copy (size, "dump complete" marker, no NUL byte, the
#      \restrict and \unrestrict lines of pg_dump 16.10+, which it strips, and as many
#      `COPY ... FROM stdin;` lines as lines that end COPY data, see below); everything
#      below uses the copy, so a file that is rotated away, truncated or replaced
#      meanwhile cannot change what is loaded,
#   2. checks that the db service is running and that its psql is one restore.sh
#      supports: 16.10 or later, 17.6 or later, or 18 and later,
#   3. loads the copy into a scratch database (restore_scratch_<random>, created from
#      template0 in the same server, dropped again right after and on every exit, unless
#      the DROP itself fails: then it prints the command and why), in exactly the form
#      step 6 uses; a dump that fails there is refused, and nothing was changed (the app
#      still runs, no pre-restore dump was taken),
#   4. stops the app service when it is running (the app holds connections that
#      would block the DROPs and write rows while the schema is replaced),
#   5. takes a dump of the CURRENT state with scripts/backup.sh into BACKUP_DIR
#      (rotation skipped), unless --no-pre-backup; a failure ends the run before
#      anything is changed and the app is started again,
#   6. pipes `BEGIN;`, `DROP SCHEMA public CASCADE; CREATE SCHEMA public ...`, the
#      dump and, only when the whole dump was read successfully, the transaction check
#      and `COMMIT;` into psql with ON_ERROR_STOP=1. psql is not given
#      --single-transaction because that commits at end of input: an input that ends
#      early (the copy unreadable) would commit a dropped, empty schema. Without the
#      final COMMIT the session ends in a rollback, so any error or short input leaves
#      the database with its old content,
#   7. runs the migrate service (RESTORE_MIGRATE_SERVICE), so a dump that predates a
#      schema change gets the columns and tables the deployed code expects, exactly
#      as every deploy does (`prisma db push`). The self-hosting docker-compose.yml has
#      no migrate service: with RESTORE_MIGRATE_SERVICE empty this step is skipped and
#      the script says so (apply the schema by hand, docs/configuration.md, Self-hosting),
#   8. starts the app again, only after steps 6 and 7 succeeded. After a failure the
#      app stays stopped on purpose: look at the error first.
#
# How a load (steps 3 and 6) keeps the dump inside its transaction, without reading the
# SQL itself (psql does that): the load first sets standard_conforming_strings and
# client_encoding, so psql reads the bytes before the dump's own SET lines the same way in
# both databases whatever their database-level settings are (a RESET in the dump brings the
# database default back; out of scope, see 'Not a security boundary'). The dump runs in psql's restricted mode under a key
# this script draws from /dev/urandom (`\restrict <key>` before the dump, `\unrestrict
# <key>` after it), so every psql meta-command in the dump (\connect, \q, \!, \i, \o,
# \set ..., also in the middle of a line) is an error and stops psql. Before the dump psql
# stores txid_current() in a variable; after it, a check statement fails when
# txid_current() has changed, i.e. when a COMMIT, END, ROLLBACK, ABORT (or the AND CHAIN
# forms) in the dump ended the transaction and a new one began. In the real database such
# a COMMIT would already have committed before the check fails, which is why the check
# runs in the scratch database first. A second check, also before the COMMIT, compares the
# number of COPY commands psql ran (the "COPY <n>" lines it printed into a file in the db
# service's /tmp) with the number of `COPY ... FROM stdin;` lines of the dump, see
# COPY_COUNT_SQL. Last, psql echoes a random token after the COMMIT, and the load counts
# only when psql exits 0 AND printed that token: psql that ends without running the COMMIT
# (the input ended inside COPY data, a string or a comment) is a failure, not a silent
# rollback reported as success. This protects against accidents (a hand-edited or damaged
# dump); it is not a security boundary: SQL in a dump runs with the rights of the database
# role and can do harm inside one transaction too, and in the scratch stage it runs before
# the pre-restore dump and can reach the other databases of the server, so do not restore
# a dump from a source you do not trust.
#
# A pre-restore dump of an (almost) empty database is below backup.sh's size floor and
# fails validation: restore into a fresh database with --no-pre-backup.
#
# Environment (all optional; the compose, db and dump variables are the ones of backup.sh):
#   BACKUP_COMPOSE_FILE      compose file of the stack (default: <repo>/docker-compose.traefik.yml,
#                            the hosted file; docker-compose.yml for the self-hosting stack)
#   BACKUP_DB_SERVICE        Postgres service (default: db)
#   BACKUP_DIR               where the pre-restore dump and the private copy of the
#                            dump go (default: <repo>/backups)
#   RESTORE_APP_SERVICE      service stopped during the restore (default: app; empty = leave alone)
#   RESTORE_MIGRATE_SERVICE  one-shot schema service run after the restore (default: migrate,
#                            the hosted file's service; set it empty for the self-hosting
#                            docker-compose.yml, which has none: the step is skipped, the
#                            script says so, and you apply the schema yourself)
#   PG_USER / PG_DB          database user and name (default: depsight / depsight); the
#                            user needs CREATEDB for the scratch database (the compose
#                            superuser has it), which is created and dropped from the
#                            maintenance database `postgres`
#
# Exit codes:
#   0  restored (migrated, app started)
#   1  dump invalid or refused by the scratch load (nothing changed, the app untouched),
#      the scratch database could not be dropped (nothing changed; the message says how
#      to drop it), the app could not be stopped (nothing changed), psql failed or the dump could not
#      be read (nothing committed, database unchanged, app left stopped), or interrupted
#      before psql confirmed the load (check the database: if only this script was
#      stopped, psql may have committed)
#   2  refused: no file, file missing, no --yes, compose file missing, db not running,
#      psql in the db service not one restore.sh supports
#   3  the pre-restore dump failed; nothing was changed (use --no-pre-backup to go on)
#   4  the dump is restored, but the migrate step or the app start failed, or the
#      script was interrupted after the restore committed; the app is stopped or not
#      healthy: run the printed command(s) by hand
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-$REPO_ROOT/docker-compose.traefik.yml}"
DB_SERVICE="${BACKUP_DB_SERVICE:-db}"
APP_SERVICE="${RESTORE_APP_SERVICE-app}"
MIGRATE_SERVICE="${RESTORE_MIGRATE_SERVICE-migrate}"
PG_USER="${PG_USER:-depsight}"
PG_DB="${PG_DB:-depsight}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"

# The public schema as a fresh PostgreSQL 16 database has it (owner, comment, USAGE
# for everyone), so a restored database matches one created by initdb. The SET keeps
# the dozens of "drop cascades to ..." notices out of the output.
RESET_SQL='SET client_min_messages = warning;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
COMMENT ON SCHEMA public IS '"'"'standard public schema'"'"';
GRANT USAGE ON SCHEMA public TO PUBLIC;'

# The transaction check that follows the dump: it fails with this message when
# txid_current() differs from the value psql stored right after BEGIN (restore_t0): n is
# 1 then, and the text cast to an integer is the message instead of '1'. Every name is
# schema-qualified, so a search_path or a function the dump created in the public schema
# cannot answer in its place. That does not hold against a superuser dump that replaces
# objects in pg_catalog itself: such a dump is out of scope (not a security boundary, see
# above). repeat() with a count that is only known at run time keeps the planner from
# evaluating the failing cast in advance.
CHECK_SQL="SELECT pg_catalog.int4(pg_catalog.concat(pg_catalog.repeat('restore.sh: the dump ended the transaction itself (a COMMIT, END, ROLLBACK or the like in it), refusing it', n), pg_catalog.repeat('1', 1 OPERATOR(pg_catalog.-) n))) AS restore_transaction_check FROM (SELECT pg_catalog.int4(pg_catalog.txid_current() OPERATOR(pg_catalog.<>) :restore_t0) AS n) AS restore_check;"

DC=(docker compose -f "$COMPOSE_FILE")
start_hint="docker compose -f $COMPOSE_FILE start $APP_SERVICE"
migrate_hint="docker compose -f $COMPOSE_FILE run --rm -T --build $MIGRATE_SERVICE"
stopped_app=0

# The scratch database, once its CREATE was sent; dropped by drop_scratch (after the
# scratch load and on every exit path, see cleanup). The name is random, so dropping it
# when the CREATE itself failed cannot hit another database. CREATE and DROP connect to
# the maintenance database `postgres`, not to PG_DB, so a dump that dropped or renamed
# PG_DB in the scratch stage cannot keep the scratch database from being dropped. A DROP
# that fails prints psql's error and how to drop it by hand; a subscription the dump
# created in it (pg_dump writes them with connect = false, so they load) is the one known
# cause, and the hint then says how to drop the subscription first.
scratch_db=""
drop_scratch() {
  [ -n "$scratch_db" ] || return 0
  local db="$scratch_db" err drop_hint
  scratch_db=""
  if err="$("${DC[@]}" exec -T "$DB_SERVICE" psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" < /dev/null 2>&1 > /dev/null)"; then
    return 0
  fi
  [ -z "$err" ] || printf '%s\n' "$err" >&2
  drop_hint="docker compose -f $COMPOSE_FILE exec -T $DB_SERVICE psql -U $PG_USER -d postgres -c 'DROP DATABASE \"$db\" WITH (FORCE)'"
  if grep -q 'logical replication subscription' <<< "$err"; then
    echo "restore: could not drop the scratch database '$db': the dump created a subscription in it. Drop the subscription first, in that database, for each name of SELECT subname FROM pg_subscription: ALTER SUBSCRIPTION <name> DISABLE; ALTER SUBSCRIPTION <name> SET (slot_name = NONE); DROP SUBSCRIPTION <name>; (docker compose -f $COMPOSE_FILE exec -T $DB_SERVICE psql -U $PG_USER -d $db), then run: $drop_hint" >&2
  else
    echo "restore: could not drop the scratch database '$db' (see the error above); drop it by hand: $drop_hint" >&2
  fi
  return 1
}

# The file in the db service's /tmp that psql writes its command tags to during a load (see
# load_into). The load removes it at its end; a load that did not get that far leaves it,
# and cleanup removes it.
tags_file=""
tags_left=0
remove_tags() {
  [ "$tags_left" -eq 1 ] || return 0
  tags_left=0
  "${DC[@]}" exec -T "$DB_SERVICE" rm -f -- "$tags_file" < /dev/null > /dev/null 2>&1 && return 0
  echo "restore: could not remove $tags_file in the $DB_SERVICE service (psql's command tags of the load); remove it by hand" >&2
  return 1
}

# Private files in BACKUP_DIR (the copy of the dump, a work file, psql's output),
# removed on every exit path, the scratch database and the tags file.
tmp=""
work=""
out=""
cleanup() {
  [ -z "$tmp" ] || rm -f "$tmp"
  [ -z "$work" ] || rm -f "$work"
  [ -z "$out" ] || rm -f "$out"
  drop_scratch || true
  remove_tags || true
}
trap cleanup EXIT

# Phase markers: real_load is set right before the load into the real database starts,
# committed once it returned zero and psql confirmed its COMMIT. A HUP, INT or TERM
# signal after the commit exits 4 and says the restore is committed. Before it the exit
# stays 1, but bash runs this trap only after the foreground psql pipeline returns: a
# signal sent to this script alone while psql is loading lets psql finish and possibly
# commit, and is still reported here as a stop before the commit was confirmed.
# Stopping the whole process group (Ctrl-C in the terminal) stops psql too, which then
# rolls back. Before the real load the database is untouched, and the message says so.
real_load=0
committed=0
on_signal() {
  if [ "$real_load" -eq 0 ]; then
    echo "restore: interrupted before the load into database '$PG_DB' started; it is unchanged" >&2
    [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
    exit 1
  fi
  if [ "$committed" -eq 1 ]; then
    echo "restore: interrupted after the restore committed; the database has the content of the dump" >&2
    [ -z "$MIGRATE_SERVICE" ] || echo "restore: the $MIGRATE_SERVICE step did not run; apply the schema with: $migrate_hint" >&2
    [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
    exit 4
  fi
  echo "restore: interrupted before psql confirmed the load; if only this script was stopped, psql may have finished and the database may already hold the dump: check it before assuming it is unchanged" >&2
  exit 1
}
trap on_signal HUP INT TERM

usage="usage: restore.sh --yes [--no-pre-backup] <dump.sql>"
refuse() { echo "restore: $*" >&2; exit 2; }

confirmed=0
pre_backup=1
file=""
for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=1 ;;
    --no-pre-backup) pre_backup=0 ;;
    -*) refuse "unknown option '$arg' ($usage)" ;;
    *)
      [ -z "$file" ] || refuse "more than one file given ($usage)"
      file="$arg"
      ;;
  esac
done

[ -n "$file" ] || refuse "no dump file given ($usage)"
[ -f "$file" ] || refuse "dump file not found: $file"
[ -f "$COMPOSE_FILE" ] || refuse "compose file not found: $COMPOSE_FILE"

if [ "$confirmed" -ne 1 ]; then
  echo "restore: would replace the content of database '$PG_DB' (compose file $COMPOSE_FILE) with $file." >&2
  refuse "this destroys everything not in the dump, including rows written after it; run again with --yes to proceed"
fi

# Work on a private snapshot: the later steps (the scratch load, stopping the app, the
# pre-restore dump) take time, and the file may be rotated away or truncated in between.
# The copy lives in BACKUP_DIR, the one directory whose free space backup.sh already
# depends on, and is named so that backup.sh's rotation (depsight-*.sql) never matches it.
if [ ! -d "$BACKUP_DIR" ] && ! { mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"; }; then
  echo "restore: could not prepare $BACKUP_DIR for the private copy of the dump" >&2
  exit 1
fi
private_file() {
  (umask 077 && mktemp "$BACKUP_DIR/restore-dump.XXXXXX") \
    || { echo "restore: could not create a temporary file in $BACKUP_DIR" >&2; exit 1; }
}
tmp="$(private_file)"
work="$(private_file)"
out="$(private_file)"
if ! cp -- "$file" "$tmp"; then
  echo "restore: could not copy $file to $tmp; nothing was changed" >&2
  exit 1
fi

size="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "restore: $file is too small ($size bytes) to be a dump" >&2
  exit 1
fi
if ! grep -qx -- '-- PostgreSQL database dump complete' "$tmp"; then
  echo "restore: $file is missing the completion marker (truncated dump?)" >&2
  exit 1
fi

# The checks below read bytes (LC_ALL=C: in a UTF-8 locale an invalid sequence makes a
# line match nothing), and -a keeps grep from answering "Binary file matches".
cgrep() { LC_ALL=C grep -a "$@"; }
could_not_check() {
  echo "restore: could not check $file ($1); nothing was changed" >&2
  exit 1
}
# A NUL byte anywhere refuses the dump: psql cuts the line at it, so the rest of that
# line (a COPY value, the end of a statement) would silently not be loaded, and pg_dump
# never writes one. The copy without its NULs must be identical to the copy; a tr or cmp
# that fails refuses too.
if ! { LC_ALL=C tr -d '\000' < "$tmp" > "$work" && cmp -s "$tmp" "$work"; }; then
  # the line number: every other byte becomes x, the NUL becomes N, so N is found only once
  nul_line="$(LC_ALL=C tr -c '\000\n' x < "$tmp" | LC_ALL=C tr '\000' N \
    | cgrep -n -m 1 N | LC_ALL=C cut -d: -f1 || true)"
  [ -n "$nul_line" ] || could_not_check "a NUL byte or a read error"
  echo "restore: $file contains a NUL byte (first at line $nul_line); refusing to load it" >&2
  exit 1
fi

# pg_dump 16.10 and later wraps its output in `\restrict <key>` (after the header comment)
# and `\unrestrict <key>` (the last line). The load runs the dump under a key of its own,
# and psql refuses a second \restrict inside it, so these two lines are stripped. Only
# that exact pair is accepted: no such line at all (pg_dump before 16.10), or exactly two
# lines that start (after optional white space) with \restrict or \unrestrict, the first
# being `\restrict <key>` with nothing but blank and "--" comment lines before it, the
# second `\unrestrict <the same key>` with nothing but blank lines after it. Anything else
# (one of them alone, a second pair, one in the middle, other text on the line, a carriage
# return at its end) refuses the dump. A COPY value that starts with a carriage return
# followed by "estrict" is written as a \restrict line and refused too (fail closed).
strip_refuse() {
  printf '%s\n' "restore: $file has $1; refusing to load it (only pg_dump's own pair is accepted: one \\restrict <key> line before any statement and one \\unrestrict <same key> line at the end)" >&2
  exit 1
}
rl_rc=0
rl_hits="$(cgrep -n -E -- '^[[:space:]]*\\(un)?restrict' "$tmp")" || rl_rc=$?
case "$rl_rc" in
  0|1) ;;
  *) could_not_check "the \\restrict line check failed" ;;
esac
if [ -n "$rl_hits" ]; then
  rl_count="$(printf '%s\n' "$rl_hits" | wc -l | tr -d ' ')"
  [ "$rl_count" -eq 2 ] \
    || strip_refuse "$rl_count \\restrict or \\unrestrict lines, not 2 (first at line ${rl_hits%%:*})"
  rl_first="${rl_hits%%$'\n'*}"
  rl_second="${rl_hits#*$'\n'}"
  rl_a="${rl_first%%:*}"
  rl_b="${rl_second%%:*}"
  [[ "${rl_first#*:}" =~ ^\\restrict\ ([A-Za-z0-9]+)$ ]] \
    || strip_refuse "a line at $rl_a that is not exactly \\restrict <key>"
  [ "${rl_second#*:}" = "\\unrestrict ${BASH_REMATCH[1]}" ] \
    || strip_refuse "a line at $rl_b that is not exactly \\unrestrict with the key of line $rl_a"
  # the first line that is neither blank nor a "--" comment must be the \restrict line
  rl_rc=0
  rl_lead="$(cgrep -n -m 1 -v -E -- '^(--.*)?$' "$tmp" | LC_ALL=C cut -d: -f1)" || rl_rc=$?
  [ "$rl_rc" -eq 0 ] || could_not_check "the \\restrict position check failed"
  [ "$rl_lead" = "$rl_a" ] || strip_refuse "a statement at line $rl_lead before the \\restrict line"
  # the last line that is not empty must be the \unrestrict line
  rl_rc=0
  rl_tail="$(cgrep -n -v -x -- '' "$tmp" | tail -n 1 | LC_ALL=C cut -d: -f1)" || rl_rc=$?
  [ "$rl_rc" -eq 0 ] || could_not_check "the \\unrestrict position check failed"
  [ "$rl_tail" = "$rl_b" ] || strip_refuse "text at line $rl_tail after the \\unrestrict line"
  # drop the \restrict line and everything from the \unrestrict line on (only blank lines)
  LC_ALL=C sed -e "${rl_a}d" -e "${rl_b},\$d" "$tmp" > "$work" \
    || could_not_check "stripping the \\restrict lines failed"
  mv -f -- "$work" "$tmp" || could_not_check "stripping the \\restrict lines failed"
  work="$(private_file)"
fi

# psql 15 and 16 have a quirk: an empty statement (`;`, `/* c */ ;`, also `(SELECT 1);`)
# right after a COPY FROM STDIN makes psql read on as if it were more COPY data and drop
# everything up to the next line that ends COPY data (exactly `\.`, or `\.` and a carriage
# return), then go on with exit 0. Without a check, the next table's COPY and its rows
# would be gone and the restore would report success. Two checks catch it, without
# reading the SQL. This one, before anything is touched: the dump must have as many lines
# in pg_dump's form `COPY <table> [(<columns>)] FROM stdin;` (copy_lines) as lines that end
# COPY data. pg_dump writes exactly one of each per table, and its COPY data never holds
# such a line. Each COPY psql runs reads up to one of those end lines, and so does every
# skip; so with equal counts a skip always takes one of the dump's COPY statements with
# it. The second check, in the load (COPY_COUNT_SQL), then sees psql run fewer COPY
# commands than copy_lines and refuses. A skip that reaches the end of the input takes the
# check and the COMMIT with it: no sentinel. False refusals (fail closed): a line that is
# exactly `\.` or in the COPY form inside a string, comment or function body, a COPY value
# that is such a line, a COPY pg_dump does not write (another spelling, no schema, a name
# with a newline, a server-side COPY from or to a file); COPY ... TO STDOUT prints no tag.
# pg_dump's form: a schema-qualified table, the column list (none for a table without
# columns, then two spaces), each name plain or double-quoted; a carriage return at the end
# is allowed, like psql allows it after `\.`.
cl_id='("([^"]|"")*"|[^ "(),.]+)'
cl_rc=0
copy_lines="$(cgrep -c -x -E -- "COPY $cl_id\\.$cl_id( \\($cl_id(, $cl_id)*\\))? +FROM stdin;"$'\r''?' "$tmp")" || cl_rc=$?
case "$cl_rc" in 0|1) ;; *) could_not_check "counting the COPY lines failed" ;; esac
cl_rc=0
copy_ends="$(cgrep -c -x -E -- '\\\.'$'\r''?' "$tmp")" || cl_rc=$?
case "$cl_rc" in 0|1) ;; *) could_not_check "counting the ends of COPY data failed" ;; esac
[[ "$copy_lines" =~ ^[0-9]+$ && "$copy_ends" =~ ^[0-9]+$ ]] || could_not_check "counting the COPY lines failed"
if [ "$copy_lines" != "$copy_ends" ]; then
  echo "restore: $file has $copy_lines lines of the form COPY ... FROM stdin; but $copy_ends lines that end COPY data (exactly \\.); refusing it (pg_dump writes one of each per table, and psql can skip statements silently where they differ)" >&2
  exit 1
fi

running="$("${DC[@]}" ps --status running --services)" \
  || refuse "docker compose could not list the services of $COMPOSE_FILE"
grep -qx "$DB_SERVICE" <<< "$running" \
  || refuse "service '$DB_SERVICE' is not running in $COMPOSE_FILE; start the db first"

# restore.sh supports psql 16.10+, 17.6+ and 18+ (the load needs \restrict); any other
# version is refused up front with the version named, instead of failing on a psql error.
psql_version="$("${DC[@]}" exec -T "$DB_SERVICE" psql --version < /dev/null)" \
  || refuse "could not run psql --version in the $DB_SERVICE service"
if [[ "$psql_version" =~ ^psql\ \(PostgreSQL\)\ ([0-9]+)\.([0-9]+) ]]; then
  pg_major="${BASH_REMATCH[1]}"
  pg_minor="${BASH_REMATCH[2]}"
else
  refuse "cannot read the psql version of the $DB_SERVICE service ('$psql_version'); restore.sh supports psql 16.10+, 17.6+ and 18+"
fi
if ! { [ "$pg_major" -eq 16 ] && [ "$pg_minor" -ge 10 ]; } \
  && ! { [ "$pg_major" -eq 17 ] && [ "$pg_minor" -ge 6 ]; } \
  && ! [ "$pg_major" -ge 18 ]; then
  refuse "psql in the $DB_SERVICE service is $pg_major.$pg_minor; restore.sh supports psql 16.10+, 17.6+ and 18+: pull a newer image for the db service first"
fi

echo "restore: compose file $COMPOSE_FILE, database '$PG_DB', dump $file"

# The key of the restricted mode, the token psql echoes after its COMMIT and the name of
# the scratch database: random, never taken from the dump, so the dump cannot know them.
rand_hex() { LC_ALL=C od -An -tx1 -N"$1" /dev/urandom | LC_ALL=C tr -d ' \n'; }
key="$(rand_hex 16)"
token="$(rand_hex 16)"
scratch_name="restore_scratch_$(rand_hex 8)"
tags_file="/tmp/restore-$(rand_hex 8).tags"
[[ "$key" =~ ^[0-9a-f]{32}$ && "$token" =~ ^[0-9a-f]{32}$ && "$scratch_name" =~ ^restore_scratch_[0-9a-f]{16}$ \
  && "$tags_file" =~ ^/tmp/restore-[0-9a-f]{16}\.tags$ ]] \
  || could_not_check "reading random bytes from /dev/urandom failed"
sentinel="restore: committed $token"

# The COPY count of a load (see the quirk above the copy_lines check). psql writes its
# output during the dump (command tags such as "COPY 3", query results) into tags_file
# in the db service (\o, set before \restrict, so the dump cannot change it), and after
# \unrestrict counts the lines that are exactly "COPY <n>" and removes the file (a shell
# command in the db service, the postgres image has sh and grep). Query results cannot
# look like such a line: psql's aligned format starts every line of a result with a space
# or a "-" or a "(". The check fails unless that count is copy_lines, before the COMMIT, so
# in the real database too a mismatch rolls the load back. A dump made to fool it (a
# COPY ... TO STDOUT that prints such a line, next to an empty statement after COPY data)
# is out of scope: not a security boundary.
COUNT_CMD="\\set restore_copies \`LC_ALL=C grep -c -x -E 'COPY [0-9]+' $tags_file; rm -f $tags_file\`"
COPY_COUNT_SQL="SELECT pg_catalog.int4(pg_catalog.concat(pg_catalog.repeat(pg_catalog.concat('restore.sh: psql ran ', :'restore_copies', ' COPY commands, the dump has $copy_lines lines of the form COPY ... FROM stdin; (psql skipped part of the dump, for example after an empty statement that follows COPY data, or a COPY is in a form pg_dump does not write), refusing it'), n), pg_catalog.repeat('1', 1 OPERATOR(pg_catalog.-) n))) AS restore_copy_check FROM (SELECT pg_catalog.int4(:'restore_copies' OPERATOR(pg_catalog.<>) '$copy_lines') AS n) AS restore_check;"

# The trailer must start a line: a dump whose last byte is not a newline could end in a
# "--" comment, which would swallow it. A dump that ends in a newline gets nothing added.
body_nl=""
[ -z "$(tail -c 1 "$tmp")" ] || body_nl=$'\n'

# load_into <database>: one psql session that loads the copy in the form described at the
# top. The trailer (from \unrestrict on) is sent only when the whole copy was read: if cat
# fails, psql sees end of input inside the open transaction and rolls it back (pipefail
# turns the failure of the left side into the failure of the pipeline). After \unrestrict,
# `ANALYZE pg_catalog.pg_am;` (a tiny catalog table) ends whatever the dump left
# unterminated: ANALYZE is a reserved word, and no statement goes on validly with
# `ANALYZE pg_catalog.pg_am` (EXPLAIN ANALYZE needs a statement after it, VACUUM cannot run
# in a transaction), so a dangling statement is an error instead of swallowing the check;
# alone it only refreshes the statistics of pg_am. It is not a bare ";", which would be an
# empty statement: right after COPY data that makes psql drop the rest of the input (the
# quirk above the copy_lines check). The `\o` after the transaction check closes the tags
# file, COUNT_CMD counts its COPY lines, and COPY_COUNT_SQL fails unless the count is
# copy_lines. psql runs without -q, so it prints the command tags. Returns 0 only when
# psql exited 0 and printed the sentinel; psql's other output goes to a private file
# (umask 077 in case something removed it), so it never reaches the screen.
load_into() {
  local old_umask load_rc=0
  old_umask="$(umask)"
  umask 077
  tags_left=1
  { printf '%s\n' 'SET standard_conforming_strings = on;' "SET client_encoding = 'UTF8';" 'BEGIN;' \
      'SELECT pg_catalog.txid_current() AS restore_t0 \gset' "\\o $tags_file" "\\restrict $key" "$RESET_SQL"
    cat "$tmp" && printf '%s\\unrestrict %s\nANALYZE pg_catalog.pg_am;\n%s\n\\o\n%s\n%s\nCOMMIT;\n\\echo %s\n' \
      "$body_nl" "$key" "$CHECK_SQL" "$COUNT_CMD" "$COPY_COUNT_SQL" "$sentinel"
  } | "${DC[@]}" exec -T "$DB_SERVICE" psql -X -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$1" > "$out" \
    || load_rc=1
  umask "$old_umask"
  [ "$load_rc" -eq 0 ] || return 1
  grep -qxF -- "$sentinel" "$out" || return 2
  # the trailer ran, COUNT_CMD removed the tags file
  tags_left=0
}

echo "restore: loading $file into a scratch database first ($scratch_name)"
scratch_db="$scratch_name"
if ! "${DC[@]}" exec -T "$DB_SERVICE" psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres \
  -c "CREATE DATABASE \"$scratch_name\" TEMPLATE template0" < /dev/null > /dev/null; then
  echo "restore: could not create the scratch database $scratch_name (the role $PG_USER needs CREATEDB, and the volume room for a second copy of the data); nothing was changed" >&2
  exit 1
fi
scratch_rc=0
load_into "$scratch_name" || scratch_rc=$?
case "$scratch_rc" in
  0) ;;
  1)
    echo "restore: $file does not load into the scratch database (see the psql error above); refusing it, nothing was changed" >&2
    exit 1
    ;;
  *)
    echo "restore: psql ended without running the COMMIT after $file in the scratch database (the dump ends inside COPY data, psql dropped the rest of the input after an empty statement that follows COPY data, or psql stopped reading early); refusing it, nothing was changed" >&2
    exit 1
    ;;
esac
drop_scratch || { echo "restore: nothing was changed" >&2; exit 1; }

if [ -n "$APP_SERVICE" ] && grep -qx "$APP_SERVICE" <<< "$running"; then
  echo "restore: stopping $APP_SERVICE"
  if ! "${DC[@]}" stop "$APP_SERVICE"; then
    echo "restore: could not stop $APP_SERVICE; nothing was changed" >&2
    exit 1
  fi
  stopped_app=1
fi

if [ "$pre_backup" -eq 1 ]; then
  echo "restore: backing up the current state first (scripts/backup.sh)"
  if ! BACKUP_COMPOSE_FILE="$COMPOSE_FILE" BACKUP_DB_SERVICE="$DB_SERVICE" PG_USER="$PG_USER" PG_DB="$PG_DB" \
    BACKUP_SKIP_ROTATION=1 "$SCRIPT_DIR/backup.sh"; then
    echo "restore: the pre-restore backup failed; nothing was changed. Fix it, or pass --no-pre-backup to restore without it" >&2
    if [ "$stopped_app" -eq 1 ]; then
      echo "restore: starting $APP_SERVICE again"
      "${DC[@]}" start "$APP_SERVICE" || echo "restore: could not start $APP_SERVICE; run: $start_hint" >&2
    fi
    exit 3
  fi
fi

echo "restore: restoring $file into database '$PG_DB'"
real_load=1
real_rc=0
load_into "$PG_DB" || real_rc=$?
if [ "$real_rc" -eq 1 ]; then
  echo "restore: psql failed or the dump could not be read; nothing was committed, the database is unchanged" >&2
  [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
  exit 1
elif [ "$real_rc" -ne 0 ]; then
  echo "restore: psql ended without confirming the COMMIT; nothing should be committed, but check the database before relying on it" >&2
  [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; start it with: $start_hint" >&2
  exit 1
fi
# psql exited 0 and printed the token after its COMMIT: the restore is committed. A
# signal from here on exits 4 and says so.
committed=1

if [ -n "$MIGRATE_SERVICE" ]; then
  echo "restore: applying the current schema ($MIGRATE_SERVICE)"
  if ! "${DC[@]}" run --rm -T --build "$MIGRATE_SERVICE"; then
    echo "restore: the dump is restored, but the $MIGRATE_SERVICE step (image build or schema push) failed; see the output above (a dump taken from newer code than the deployed code is one example)." >&2
    [ "$stopped_app" -eq 0 ] || echo "restore: $APP_SERVICE is still stopped; after fixing it run: $start_hint" >&2
    exit 4
  fi
else
  echo "restore: RESTORE_MIGRATE_SERVICE is empty, schema step skipped; if the dump predates the deployed code, apply the schema yourself now (self-hosting: docs/configuration.md, Self-hosting, step 3) and restart the app"
fi

if [ "$stopped_app" -eq 1 ]; then
  echo "restore: starting $APP_SERVICE"
  if ! "${DC[@]}" start "$APP_SERVICE"; then
    echo "restore: the dump is restored, but $APP_SERVICE did not start; run: $start_hint" >&2
    exit 4
  fi
fi
echo "restore: done"
