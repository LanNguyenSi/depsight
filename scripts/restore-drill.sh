#!/usr/bin/env bash
# Restore drill: proves that scripts/backup.sh and scripts/restore.sh round-trip a
# real database. Runs in CI against a throwaway Postgres 16 and can be run by hand
# against any scratch Postgres container; never point it at production.
#
# It applies the schema the way the hosted `migrate` service does (the pre-push
# SQL, then `prisma db push`), seeds a few rows (some whose COPY lines start with END;
# or an escaped backslash) and functions with plpgsql and BEGIN ATOMIC bodies, runs the
# REAL scripts/backup.sh, restores the dump with the REAL scripts/restore.sh into a
# second, freshly created database, and asserts row counts, one row's content, the
# Advisory unique index and that the restored database dumps exactly like the source.
# Then it restores the same dump into that now populated database after a newer
# release's table (with a foreign key into a dumped table) and a row written after the
# dump were added: both must be gone afterwards, the pre-restore dump must hold them,
# and `prisma db push` must find the schema in sync. Then:
#   - the restore modes of the docs and the Makefile (hosted with the migrate step,
#     self-hosting without it, each with and without the pre-restore dump), for a dump
#     with and one without --clean;
#   - a second source database with the awkward content of tests/fixtures/restore-drill-rich.sql;
#   - a data-only dump and a --create dump (both refused: restore.sh resets the public
#     schema, and \connect is a psql command);
#   - the corpus below: dumps with transaction control, psql commands, unterminated
#     input and the like added; each must be refused with the database unchanged and no
#     scratch database left, or load correctly. It ends with a table of the outcomes.
# The scripts see a `docker` shim that maps `docker compose -f <file> exec -T db <cmd>`
# onto `docker exec -i <container> <cmd>`, so every pg_dump and psql option comes from
# the scripts themselves: if their options drift, this drill fails. `docker compose run
# ... migrate` runs the migrate service's two commands from this checkout.
#
# Usage:
#   DRILL_PG_CONTAINER=<container of a postgres:16 started with user/db depsight> \
#   DRILL_DATABASE_URL=postgresql://depsight:<password>@127.0.0.1:<port>/depsight \
#   [DRILL_REPORT=<file for the corpus table>] scripts/restore-drill.sh
# Run it from anywhere; it uses the checkout it lives in (needs `npm ci` done).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DRILL_PG_CONTAINER:?set DRILL_PG_CONTAINER to the scratch Postgres container}"
: "${DRILL_DATABASE_URL:?set DRILL_DATABASE_URL to the connection URL of its depsight database}"
SRC_DB=depsight
DST_DB=depsight_restored
RICH_SRC=drill_rich
RICH_DST=drill_rich_restored
EXPECT_USERS=5
EXPECT_REPOS=3
EXPECT_FULLNAME='drill/restored-repo'
SIDE_EFFECT=/tmp/restore-drill-side-effect

REAL_DOCKER="$(command -v docker)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/backups"
: > "$WORK/compose.yml"

# The shim answers only the compose calls the scripts make.
cat > "$WORK/bin/docker" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = compose ] && [ "\$2" = -f ]; then
  shift 3
  case "\$1" in
    ps) echo db; exit 0 ;;
    exec)
      shift
      [ "\$1" = -T ] && shift
      shift # service name
      # DRILL_RM_ON_DUMP: files (glob allowed) removed when a pg_dump runs, i.e. between
      # restore.sh validating its copy of the dump and loading it
      case "\$*" in
        *pg_dump*) [ -z "\${DRILL_RM_ON_DUMP:-}" ] || rm -f \$DRILL_RM_ON_DUMP ;;
      esac
      exec "$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" "\$@"
      ;;
    run)
      # the migrate service of docker-compose.traefik.yml: the pre-push SQL, then
      # prisma db push, against DRILL_MIGRATE_URL
      [ "\${*: -1}" = migrate ] && [ -n "\${DRILL_MIGRATE_URL:-}" ] || { echo "drill docker shim: unexpected run: \$*" >&2; exit 9; }
      cd "$REPO_ROOT" || exit 9
      DATABASE_URL="\$DRILL_MIGRATE_URL" HOME="$WORK" npx prisma db execute \
        --file prisma/pre-push/advisory-unique-key.sql --schema=prisma/schema.prisma \
        && DATABASE_URL="\$DRILL_MIGRATE_URL" HOME="$WORK" npx prisma db push --skip-generate \
          --schema=prisma/schema.prisma
      exit \$?
      ;;
  esac
fi
echo "drill docker shim: unexpected call: \$*" >&2
exit 9
SHIM
chmod +x "$WORK/bin/docker"

sql() { # sql <database> <statement>: print the bare result
  "$REAL_DOCKER" exec -i -e PGOPTIONS='-c client_min_messages=warning' "$DRILL_PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U depsight -d "$1" -tA -c "$2"
}
fail() { echo "drill: FAIL: $*" >&2; exit 1; }
expect() { # expect <label> <actual> <expected>
  [ "$2" = "$3" ] || fail "$1: got '$2', expected '$3'"
  echo "drill: ok: $1 = $3"
}
# fingerprint <database>: a checksum of its plain pg_dump (schema and data), without the
# \restrict lines, whose key is new on every run
fingerprint() {
  "$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_dump -U depsight -d "$1" | grep -v -E '^\\(un)?restrict ' | cksum
}
scratch_count() { sql postgres "SELECT count(*) FROM pg_database WHERE datname LIKE 'restore\\_scratch\\_%'"; }
fresh_db() { sql postgres "DROP DATABASE IF EXISTS $1" > /dev/null; sql postgres "CREATE DATABASE $1 OWNER depsight" > /dev/null; }
# drill_restore <database> <dump> [restore.sh options]: runs the real restore.sh through
# the shim, self-hosting form (no app, no migrate step) unless DRILL_MIGRATE_URL is set;
# sets rc, keeps its stderr in $WORK/last.err
drill_restore() {
  local db="$1" f="$2" migrate=''
  shift 2
  [ -z "${DRILL_MIGRATE_URL:-}" ] || migrate=migrate
  rc=0
  PATH="$WORK/bin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" BACKUP_DIR="$WORK/backups" \
    RESTORE_APP_SERVICE='' RESTORE_MIGRATE_SERVICE="$migrate" PG_DB="$db" \
    "$REPO_ROOT/scripts/restore.sh" --yes "$@" "$f" > "$WORK/last.out" 2> "$WORK/last.err" || rc=$?
}

echo "drill: applying the schema like the migrate service"
cd "$REPO_ROOT"
DATABASE_URL="$DRILL_DATABASE_URL" HOME="$WORK" npx prisma db execute \
  --file prisma/pre-push/advisory-unique-key.sql --schema=prisma/schema.prisma
DATABASE_URL="$DRILL_DATABASE_URL" HOME="$WORK" npx prisma db push --skip-generate \
  --schema=prisma/schema.prisma

echo "drill: seeding"
sql "$SRC_DB" 'TRUNCATE "User" CASCADE' > /dev/null
sql "$SRC_DB" "INSERT INTO \"User\" (id, \"githubId\", \"githubLogin\", \"githubToken\", \"updatedAt\") VALUES
  ('drill-u1', '9001', 'drill-one', 'tok-one', now()),
  ('drill-u2', '9002', 'drill-two', 'tok-two', now()),
  ('END;', '9003', E'first\nEND;\nlast', 'tok-end', now()),
  (E'\\\\q', '9004', 'COMMIT;', 'tok-q', now()),
  (E'\\\\x', '9005', E'\\\\.', 'tok-x', now())" > /dev/null
sql "$SRC_DB" "INSERT INTO \"Repo\" (id, \"userId\", \"githubId\", owner, name, \"fullName\", \"updatedAt\") VALUES
  ('drill-r1', 'drill-u1', 1, 'drill', 'one', 'drill/one', now()),
  ('drill-r2', 'drill-u1', 2, 'drill', 'two', 'drill/two', now()),
  ('drill-r3', 'drill-u2', 3, 'drill', 'restored-repo', '$EXPECT_FULLNAME', now())" > /dev/null
# routines are not part of the prisma schema; prisma db push leaves them alone
sql "$SRC_DB" 'DROP FUNCTION IF EXISTS public.drill_plpgsql(integer); DROP FUNCTION IF EXISTS public.drill_atomic(integer); DROP PROCEDURE IF EXISTS public.drill_atomic_proc(integer)' > /dev/null
sql "$SRC_DB" 'CREATE FUNCTION public.drill_plpgsql(x integer) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  IF x > 0 THEN
    RETURN 1;
  END IF;
  RETURN 0;
END;
$$' > /dev/null
sql "$SRC_DB" 'CREATE FUNCTION public.drill_atomic(x integer) RETURNS integer LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN x > 5 THEN 2 ELSE 1 END;
END' > /dev/null
sql "$SRC_DB" 'CREATE PROCEDURE public.drill_atomic_proc(a integer) LANGUAGE sql
BEGIN ATOMIC
  SELECT a;
END' > /dev/null
expect "seeded users" "$(sql "$SRC_DB" 'SELECT count(*) FROM "User"')" "$EXPECT_USERS"

echo "drill: backup.sh"
PATH="$WORK/bin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" BACKUP_DIR="$WORK/backups" \
  PG_DB="$SRC_DB" "$REPO_ROOT/scripts/backup.sh"
dump="$(find "$WORK/backups" -maxdepth 1 -name 'depsight-*.sql')"
if [ -z "$dump" ] || [ "$(wc -l <<< "$dump" | tr -d ' ')" != 1 ]; then
  fail "expected exactly one dump in $WORK/backups"
fi
cp "$dump" "$WORK/first.sql"
# what the dump must hold for the restores below to prove anything
grep -q -x 'END;' "$dump" || fail "the dump has no END; line (plpgsql or BEGIN ATOMIC body)"
grep -q 'BEGIN ATOMIC' "$dump" || fail "the dump has no BEGIN ATOMIC body"
grep -q -E '^END;'$'\t' "$dump" || fail "the dump has no COPY line that starts with END;"
grep -q -E '^\\\\q'$'\t' "$dump" || fail "the dump has no COPY line that starts with \\\\q"
grep -q -E '^\\\\x'$'\t' "$dump" || fail "the dump has no COPY line that starts with \\\\x"
grep -q -E '^\\restrict [A-Za-z0-9]+$' "$dump" || fail "the dump has no \\restrict line (pg_dump older than 16.10?)"
printf '%s\n' 'drill: ok: the dump holds END; lines, BEGIN ATOMIC, COPY lines with END; \\q \\x, and the \restrict pair'
src_fp="$(fingerprint "$SRC_DB")"

echo "drill: restore.sh into a fresh database"
fresh_db "$DST_DB"
# A fresh database is below backup.sh's size floor, so no pre-restore dump here; without
# DRILL_MIGRATE_URL the migrate step is skipped (the next case runs prisma itself).
drill_restore "$DST_DB" "$dump" --no-pre-backup
[ "$rc" -eq 0 ] || fail "restore into a fresh database: exit $rc: $(cat "$WORK/last.err")"

echo "drill: asserting the restored database"
expect "restored users" "$(sql "$DST_DB" 'SELECT count(*) FROM "User"')" "$EXPECT_USERS"
expect "restored repos" "$(sql "$DST_DB" 'SELECT count(*) FROM "Repo"')" "$EXPECT_REPOS"
expect "restored row content" \
  "$(sql "$DST_DB" "SELECT \"fullName\" || '|' || \"userId\" FROM \"Repo\" WHERE id = 'drill-r3'")" \
  "$EXPECT_FULLNAME|drill-u2"
expect "restored token" "$(sql "$DST_DB" "SELECT \"githubToken\" FROM \"User\" WHERE id = 'drill-u2'")" "tok-two"
expect "restored multi-line value" "$(sql "$DST_DB" "SELECT replace(\"githubLogin\", E'\\n', '|') FROM \"User\" WHERE id = 'END;'")" "first|END;|last"
expect "restored backslash ids" "$(sql "$DST_DB" "SELECT string_agg(id || '=' || \"githubLogin\", ',' ORDER BY id) FROM \"User\" WHERE id LIKE E'\\\\\\\\%'")" '\q=COMMIT;,\x=\.'
expect "restored functions" "$(sql "$DST_DB" 'SELECT public.drill_plpgsql(3)::text || public.drill_atomic(7)::text')" 12
expect "advisory unique index" \
  "$(sql "$DST_DB" "SELECT count(*) FROM pg_indexes WHERE tablename = 'Advisory' AND indexdef LIKE '%UNIQUE%scanId%ghsaId%packageName%'")" 1
expect "restored database dumps like the source" "$(fingerprint "$DST_DB")" "$src_fp"
expect "scratch databases left" "$(scratch_count)" 0

echo "drill: restore into a populated database whose schema is newer than the dump"
DST_URL="${DRILL_DATABASE_URL%/"$SRC_DB"}/$DST_DB"
[ "$DST_URL" != "$DRILL_DATABASE_URL" ] || fail "DRILL_DATABASE_URL must end in /$SRC_DB"
# add_newer_state: what a newer release and later writes leave in DST_DB
add_newer_state() {
  sql "$DST_DB" 'CREATE TABLE drill_extra (id text PRIMARY KEY, "repoId" text NOT NULL REFERENCES "Repo"(id))' > /dev/null
  sql "$DST_DB" "INSERT INTO drill_extra VALUES ('x1', 'drill-r1')" > /dev/null
  sql "$DST_DB" "INSERT INTO \"User\" (id, \"githubId\", \"githubLogin\", \"githubToken\", \"updatedAt\") VALUES ('drill-post', '9099', 'written-after-dump', 'tok-post', now())" > /dev/null
}
add_newer_state
expect "users before the second restore" "$(sql "$DST_DB" 'SELECT count(*) FROM "User"')" "$((EXPECT_USERS + 1))"
rm -f "$dump"
drill_restore "$DST_DB" "$WORK/first.sql"
[ "$rc" -eq 0 ] || fail "restore into a populated database: exit $rc: $(cat "$WORK/last.err")"
expect "users after the second restore" "$(sql "$DST_DB" 'SELECT count(*) FROM "User"')" "$EXPECT_USERS"
expect "row written after the dump" "$(sql "$DST_DB" "SELECT count(*) FROM \"User\" WHERE id = 'drill-post'")" 0
expect "table of the newer schema" "$(sql "$DST_DB" "SELECT coalesce(to_regclass('public.drill_extra')::text, 'gone')")" gone
expect "repos after the second restore" "$(sql "$DST_DB" 'SELECT count(*) FROM "Repo"')" "$EXPECT_REPOS"
expect "public schema owner" "$(sql "$DST_DB" "SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'public'")" pg_database_owner
pre="$(find "$WORK/backups" -maxdepth 1 -name 'depsight-*.sql')"
[ -n "$pre" ] && [ "$(wc -l <<< "$pre" | tr -d ' ')" = 1 ] || fail "expected exactly one pre-restore dump"
grep -q 'drill_extra' "$pre" || fail "the pre-restore dump lacks the newer table"
grep -q 'written-after-dump' "$pre" || fail "the pre-restore dump lacks the row written after the dump"
rm -f "$pre"
echo "drill: ok: pre-restore dump holds the replaced state"
# The migrate step: the schema must already match what prisma db push would build.
push_out="$(DATABASE_URL="$DST_URL" HOME="$WORK" npx prisma db push --skip-generate --schema=prisma/schema.prisma 2>&1)" \
  || fail "prisma db push failed on the restored database: $push_out"
grep -q 'already in sync' <<< "$push_out" || fail "restored schema is not in sync with prisma/schema.prisma: $push_out"
echo "drill: ok: prisma db push finds the restored schema in sync"

echo "drill: a failing restore must leave the database unchanged"
# The statements before the failure would be committed (and the rows gone) if the
# restore were not one transaction that commits only at the end.
awk '/^-- PostgreSQL database dump complete/ { print "DELETE FROM public.\"Repo\";"; print "SELECT 1/0;" } { print }' \
  "$WORK/first.sql" > "$WORK/broken.sql"
drill_restore "$DST_DB" "$WORK/broken.sql" --no-pre-backup
[ "$rc" -ne 0 ] || fail "restore.sh accepted a dump that fails half way"
grep -q 'division by zero' "$WORK/last.err" || fail "broken dump failed for another reason: $(cat "$WORK/last.err")"
expect "repos after failed restore" "$(sql "$DST_DB" 'SELECT count(*) FROM "Repo"')" "$EXPECT_REPOS"

echo "drill: a dump that becomes unreadable after validation must leave the database unchanged"
# restore.sh loads a private copy (taken into BACKUP_DIR, here $WORK/backups). The
# shim deletes that copy when the pre-restore pg_dump runs (after the scratch load,
# before the real one), so psql receives the schema reset but no dump; the transaction
# must not be committed.
tables_before="$(sql "$DST_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "$tables_before" -gt 0 ] || fail "expected tables before the vanish case, got $tables_before"
DRILL_RM_ON_DUMP="$WORK/backups/restore-dump.*" drill_restore "$DST_DB" "$WORK/first.sql"
[ "$rc" -ne 0 ] || fail "restore.sh reported success although its copy of the dump vanished"
grep -q 'nothing was committed' "$WORK/last.err" || fail "vanish case: unexpected message: $(cat "$WORK/last.err")"
expect "tables after the vanished-dump restore" \
  "$(sql "$DST_DB" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" "$tables_before"
expect "repos after the vanished-dump restore" "$(sql "$DST_DB" 'SELECT count(*) FROM "Repo"')" "$EXPECT_REPOS"
[ -z "$(find "$WORK/backups" -maxdepth 1 -name 'restore-dump.*')" ] || fail "temporary copy of the dump was left behind"
rm -f "$WORK"/backups/depsight-*.sql

echo "drill: the restore modes (hosted with migrate, self-hosting without; with and without the pre-restore dump), for a dump with and without --clean"
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_dump -U depsight "$SRC_DB" > "$WORK/plain.sql"
! grep -q '^DROP TABLE' "$WORK/plain.sql" || fail "the dump without --clean has DROP statements"
for kind in clean plain; do
  case "$kind" in clean) f="$WORK/first.sql" ;; plain) f="$WORK/plain.sql" ;; esac
  for mode in hosted-pre hosted-nopre selfhost-pre selfhost-nopre; do
    add_newer_state
    opts=(); case "$mode" in *-nopre) opts=(--no-pre-backup) ;; esac
    case "$mode" in hosted-*) export DRILL_MIGRATE_URL="$DST_URL" ;; *) unset DRILL_MIGRATE_URL ;; esac
    drill_restore "$DST_DB" "$f" ${opts[@]+"${opts[@]}"}
    unset DRILL_MIGRATE_URL
    [ "$rc" -eq 0 ] || fail "mode $kind/$mode: exit $rc: $(cat "$WORK/last.err")"
    case "$mode" in hosted-*) grep -q 'applying the current schema (migrate)' "$WORK/last.out" || fail "mode $kind/$mode: no migrate step" ;;
      *) grep -q 'schema step skipped' "$WORK/last.out" || fail "mode $kind/$mode: the migrate step was not skipped" ;; esac
    n_pre="$(find "$WORK/backups" -maxdepth 1 -name 'depsight-*.sql' | wc -l | tr -d ' ')"
    case "$mode" in *-nopre) expect "mode $kind/$mode pre-restore dumps" "$n_pre" 0 ;; *) expect "mode $kind/$mode pre-restore dumps" "$n_pre" 1 ;; esac
    rm -f "$WORK"/backups/depsight-*.sql
    expect "mode $kind/$mode: the database dumps like the source" "$(fingerprint "$DST_DB")" "$src_fp"
    expect "mode $kind/$mode: scratch databases left" "$(scratch_count)" 0
  done
done

echo "drill: a second source database with awkward content (tests/fixtures/restore-drill-rich.sql)"
fresh_db "$RICH_SRC"
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U depsight -d "$RICH_SRC" \
  < "$REPO_ROOT/tests/fixtures/restore-drill-rich.sql" > /dev/null
rich_fp="$(fingerprint "$RICH_SRC")"
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_dump --clean --if-exists -U depsight "$RICH_SRC" > "$WORK/rich-clean.sql"
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_dump -U depsight "$RICH_SRC" > "$WORK/rich-plain.sql"
if ! { grep -q -x 'END;' "$WORK/rich-clean.sql" && grep -q -x '\\\\q' "$WORK/rich-clean.sql" && grep -q -x 'COMMIT;' "$WORK/rich-clean.sql"; }; then
  fail "the rich dump lacks its END;, \\\\q or COMMIT; lines"
fi
fresh_db "$RICH_DST"
for f in rich-clean rich-plain; do
  for opt in --no-pre-backup ''; do
    drill_restore "$RICH_DST" "$WORK/$f.sql" ${opt:+"$opt"}
    [ "$rc" -eq 0 ] || fail "rich restore $f ${opt:-with pre-restore dump}: exit $rc: $(cat "$WORK/last.err")"
    expect "rich restore $f ${opt:-with pre-restore dump}: dumps like the source" "$(fingerprint "$RICH_DST")" "$rich_fp"
    rm -f "$WORK"/backups/depsight-*.sql
  done
done
expect "rich functions" "$(sql "$RICH_DST" "SELECT public.plf(1)::text || public.atf(9)::text || public.rx('ä ')::text")" 12true
expect "rich lines" "$(sql "$RICH_DST" "SELECT count(*) FROM public.lines")" 15
expect "scratch databases left" "$(scratch_count)" 0

echo "drill: a data-only dump and a --create dump are refused, the database unchanged"
before_fp="$(fingerprint "$DST_DB")"
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_dump --data-only -U depsight "$SRC_DB" > "$WORK/data-only.sql"
"$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" pg_dump --create -U depsight "$SRC_DB" > "$WORK/create.sql"
for f in data-only create; do
  drill_restore "$DST_DB" "$WORK/$f.sql" --no-pre-backup
  [ "$rc" -ne 0 ] || fail "a $f dump was accepted"
  expect "$f dump: database unchanged" "$(fingerprint "$DST_DB")" "$before_fp"
  expect "$f dump: scratch databases left" "$(scratch_count)" 0
done

# The corpus. Each case puts a shape (a printf format) into the first dump, right before its
# completion marker, and restores that into DST_DB (self-hosting form, no pre-restore dump).
# refused: restore.sh exits non-zero, DST_DB dumps exactly as before, no scratch database
# is left. loads_same: exit 0 and DST_DB dumps like the source. loads_check: exit 0 and a
# query gives the expected value. The case ids of the stub tests that the earlier line
# check refused are kept (w*), so every input it refused is here with its outcome.
echo "drill: a dump with a COMMIT in it leaves a database that holds more than the dump unchanged"
drill_restore "$DST_DB" "$WORK/first.sql" --no-pre-backup
[ "$rc" -eq 0 ] || fail "reset before the newer-state case: exit $rc"
add_newer_state
newer_fp="$(fingerprint "$DST_DB")"
awk '/^-- PostgreSQL database dump complete/ { print "COMMIT;" } { print }' "$WORK/first.sql" > "$WORK/commit.sql"
drill_restore "$DST_DB" "$WORK/commit.sql" --no-pre-backup
[ "$rc" -ne 0 ] || fail "a dump with a COMMIT in it was accepted"
grep -q 'the dump ended the transaction itself' "$WORK/last.err" || fail "COMMIT dump refused for another reason: $(cat "$WORK/last.err")"
expect "COMMIT dump: the newer table and the row written after the dump are still there" \
  "$(sql "$DST_DB" "SELECT count(*) FROM drill_extra")|$(sql "$DST_DB" "SELECT count(*) FROM \"User\" WHERE id = 'drill-post'")" "1|1"
expect "COMMIT dump: database unchanged" "$(fingerprint "$DST_DB")" "$newer_fp"
expect "COMMIT dump: scratch databases left" "$(scratch_count)" 0

echo "drill: the corpus"
"$REAL_DOCKER" exec "$DRILL_PG_CONTAINER" rm -f "$SIDE_EFFECT"
corpus_base="$WORK/first.sql"
drill_restore "$DST_DB" "$corpus_base" --no-pre-backup
[ "$rc" -eq 0 ] || fail "corpus base: exit $rc"
fp_cur="$(fingerprint "$DST_DB")"
: > "$WORK/corpus.tsv"
inject() { # inject <printf format> <out file>
  { sed '/^-- PostgreSQL database dump complete$/,$d' "$corpus_base"
    # shellcheck disable=SC2059
    printf -- "$1"
    printf '\n'
    sed -n '/^-- PostgreSQL database dump complete$/,$p' "$corpus_base"
  } > "$2"
}
reason() { # the first line of restore.sh's stderr that explains the outcome
  grep -v -E '^(WARNING|NOTICE|HINT|DETAIL|CONTEXT|LINE [0-9]+|[[:space:]]*\^)' "$WORK/last.err" | head -n 1 \
    | sed -e "s|$WORK/case.sql|<dump>|g" -e 's|^restore: <dump> ||' | cut -c 1-110
}
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$WORK/corpus.tsv"; }
run_refused() { # run_refused <id> <file>
  drill_restore "$DST_DB" "$2" --no-pre-backup
  [ "$rc" -ne 0 ] || fail "corpus $1: restore.sh accepted it"
  [ "$(fingerprint "$DST_DB")" = "$fp_cur" ] || fail "corpus $1: the database changed: $(cat "$WORK/last.err")"
  [ "$(scratch_count)" = 0 ] || fail "corpus $1: a scratch database is left"
  record "$1" refused "$rc" "$(reason)"
  echo "drill: ok: corpus $1 refused (exit $rc)"
}
refused() { inject "$2" "$WORK/case.sql"; run_refused "$1" "$WORK/case.sql"; }
loads_same() { # loads_same <id> <format>
  inject "$2" "$WORK/case.sql"
  drill_restore "$DST_DB" "$WORK/case.sql" --no-pre-backup
  [ "$rc" -eq 0 ] || fail "corpus $1: refused (exit $rc): $(cat "$WORK/last.err")"
  fp_cur="$(fingerprint "$DST_DB")"
  [ "$fp_cur" = "$src_fp" ] || fail "corpus $1: loaded, but the database does not dump like the source"
  [ "$(scratch_count)" = 0 ] || fail "corpus $1: a scratch database is left"
  record "$1" loads 0 "same as the source"
  echo "drill: ok: corpus $1 loads, same as the source"
}
loads_check() { # loads_check <id> <format> <query> <expected>
  inject "$2" "$WORK/case.sql"
  drill_restore "$DST_DB" "$WORK/case.sql" --no-pre-backup
  [ "$rc" -eq 0 ] || fail "corpus $1: refused (exit $rc): $(cat "$WORK/last.err")"
  expect "corpus $1" "$(sql "$DST_DB" "$3")" "$4"
  expect "corpus $1 users" "$(sql "$DST_DB" 'SELECT count(*) FROM "User"')" "$EXPECT_USERS"
  [ "$(scratch_count)" = 0 ] || fail "corpus $1: a scratch database is left"
  fp_cur="$(fingerprint "$DST_DB")"
  record "$1" loads 0 "$3 = $4"
}

# transaction control: each form that ends the transaction is refused (the check after the
# dump, in the scratch database); forms that leave it open are harmless and load
refused b.commit 'COMMIT;'
refused b.commit-comment 'COMMIT/**/;'
refused b.split 'COMMIT\n;\nBEGIN\n;'
refused b.end 'END;'
refused b.rollback-chain 'ROLLBACK AND CHAIN;'
refused b.rollback 'ROLLBACK;'
refused b.prepare "PREPARE TRANSACTION 'drill';"
refused b.do-commit 'DO $$ BEGIN COMMIT; END $$;'
refused w.1 'COMMIT;'
loads_same w.2 'begin;'
refused w.3 'END;'
loads_same w2.1 'BEGIN;'
loads_same w2.2 'begin work;'
refused w2.3 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;'
loads_same w2.4 'START TRANSACTION READ ONLY;'
refused w2.5 'start   transaction isolation level repeatable read, read write, not deferrable;'
loads_same w2.5b 'BEGIN ISOLATION LEVEL READ COMMITTED;'
refused w2.5c 'BEGIN ISOLATION LEVEL READ UNCOMMITTED;'
refused w2.6 'COMMIT WORK;'
refused w2.7 'COMMIT AND NO CHAIN;'
refused w2.8 'commit transaction;'
refused w2.9 'END TRANSACTION;'
refused w2.10 'END WORK AND CHAIN;'
refused w2.11 'ROLLBACK;'
refused w2.12 'ROLLBACK AND CHAIN;'
refused w2.13 'abort;'
refused w2.14 'ABORT WORK;'
refused w2.15 'COMMIT\t ;'
refused w2.16 '    COMMIT;'
refused w2.17 '\t\tCOMMIT;'
refused w2.18 "COMMIT PREPARED 'x';"
refused w2.19 "rollback prepared 'x';"
refused w2.20 "PREPARE TRANSACTION 'x';"
refused w2.21 "PREPARE TRANSACTION 'x'"
refused w2.22 "COMMIT PREPARED 'x'"
refused w2.23 'SELECT 1; COMMIT;'
refused w2.24 'SELECT 1;COMMIT;'
refused w2.25 'SELECT 1; END;'
loads_same w2.26 'SELECT 1; BEGIN;'
refused w2.27 'SELECT 1; rollback;'
refused w2.28 'SELECT 1; ABORT;'
loads_same w2.29 'SELECT 1; START TRANSACTION;'
refused w2.30 "SELECT 1; COMMIT PREPARED 'x'"
refused w2.31 "SELECT 1; PREPARE TRANSACTION 'x'"
refused w2.32 'COMMIT\n;'
refused w2.33 'ROLLBACK -- note\n;'
loads_same w2.34 'START TRANSACTION\n;'
refused w2.35 'ABORT\n;'
refused w2.36 'SELECT 1; COMMIT AND CHAIN\n;'
refused w2.37 'SELECT 1;\nCOMMIT;'
refused w6.1 '/**/COMMIT;'
refused w6.2 'SELECT 1; /* c */ COMMIT;'
refused w6.3 '/* c\n*/ COMMIT;'
refused w6.4 '-- c\rCOMMIT;'
refused w6.5 'SELECT 1; -- x\rCOMMIT;'
refused w6.6 'SELECT 1;\rROLLBACK'
loads_same w6.9 '/* x */ BEGIN;'
refused w6.10 '/* a\nb */ END;'
refused w6.13 'END\r;'
loads_same w6.14 'BEGIN\r;'
refused w6.15 'end \r;'
refused w6.16 'END\t\r;'
refused w7.6 'COMMIT;\377'
refused w9.1 'COMMIT -- \377'
refused w9.2 'COMMIT;\377'
refused w9.4 'SELECT \377;\nCOMMIT;'
refused k.formfeed 'SELECT 1;\n\fCOMMIT;'
refused k.vtab 'SELECT 1;\n\vCOMMIT;'
refused k.cr-ends-comment 'SELECT 1; -- x\rCOMMIT;'
refused k.begin-atomic-column 'CREATE DOMAIN atomic AS int;\nCREATE TABLE tt (begin atomic);\nEND;'
refused k.begin-atomic-argument "CREATE DOMAIN atomic AS int;\nCREATE FUNCTION g(begin atomic) RETURNS int LANGUAGE sql AS 'select 1';\nEND;"
refused k.begin-atomic-column-qualified 'CREATE DOMAIN public.atomic AS int;\nCREATE TABLE public.tt (begin public.atomic);\nEND;'
refused k.begin-atomic-argument-qualified "CREATE DOMAIN public.atomic AS int;\nCREATE FUNCTION public.g(begin public.atomic) RETURNS int LANGUAGE sql AS 'select 1';\nEND;"
refused k.copy-to-stdout-cte 'COPY (WITH stdin AS (SELECT 1) SELECT * FROM stdin) TO STDOUT;\nCOMMIT;\n/*\n\\.\n*/ SELECT 1;'
refused k.scs-off "SELECT set_config('standard_conforming_strings', 'off', false);\nSELECT 'x\\\\''; COMMIT; --';"
refused k.sjis "SET client_encoding = 'SJIS';\nSELECT E'\203\\\\'; COMMIT; --';"
refused k.atomic-case-alias 'CREATE FUNCTION public.f1() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT (SELECT 1 AS case); END;\nCOMMIT;\nSELECT 1 AS end;'
refused k.function-named-begin "CREATE TABLE public.ct(a text);\nCREATE FUNCTION public.begin() RETURNS int LANGUAGE sql AS 'select 1';\nCOPY public.ct FROM stdin;\nCOMMIT;\nend;\n\\\\."
refused k.copy-from-program "CREATE TABLE public.cw(a int, stdin int);\nCOPY public.cw FROM PROGRAM 'true' WHERE a IS DISTINCT FROM stdin;\nCOMMIT;\n/*\n\\\\.\n*/ SELECT 1;"
refused k.scs-off-concat "SELECT set_config('standard_' || 'conforming_strings', 'off', false);\nSELECT 'x\\\\''; COMMIT; --';"
loads_same k.encoding-concat "SELECT set_config('client_' || 'encoding', 'SJIS', false);\nSELECT 1;"
loads_check k.paren-in-copy-where "CREATE TABLE public.cq(a text);\nCOPY public.cq FROM STDIN WHERE a <> ')(' ;\nx\n\\\\." 'SELECT a FROM public.cq' x
loads_same k.clean 'SELECT 1;'
refused d.commit-after-delete 'DELETE FROM public."Repo";\nCOMMIT;'
refused d.search-path-hijack 'CREATE TABLE public.drill_t0 AS SELECT pg_catalog.txid_current() AS t;\nCREATE FUNCTION public.txid_current() RETURNS bigint LANGUAGE sql AS $$ SELECT t FROM public.drill_t0 $$;\nSET search_path = public, pg_catalog;\nCOMMIT;'
refused d.commit-escaped-semicolon 'COMMIT\\;'
refused d.escaped-semicolon-commit 'SELECT 1\\; COMMIT;'
refused d.procedure-commit 'CREATE PROCEDURE public.drill_p() LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$;\nCALL public.drill_p();'
refused d.vacuum 'VACUUM;'
refused d.create-database 'CREATE DATABASE drill_never;'
refused d.terminate 'SELECT pg_terminate_backend(pg_backend_pid());'

# psql commands: restricted mode refuses every one, at the start of a line or in the middle
refused b.mid-line-quit 'SELECT 1; \\q'
refused b.shell "\\\\! touch $SIDE_EFFECT"
refused b.shell-mid-line "SELECT 1; \\\\! touch $SIDE_EFFECT"
refused b.connect '\\connect postgres'
refused b.output "\\\\o $SIDE_EFFECT"
refused b.include '\\i /etc/hostname'
refused d.unrestrict-guess '\\unrestrict 00000000000000000000000000000000'
refused d.unrestrict-guess-mid-line 'SELECT 1; \\unrestrict 00000000000000000000000000000000'
refused d.if '\\if false'
refused d.restrict-mid-line 'SELECT 1; \\restrict other'
refused w3.1 '\\c other'
refused w3.2 '\\connect other'
refused w3.3 '\\q'
refused w3.4 '\\quit'
refused w3.5 '\\i /etc/passwd'
refused w3.6 '\\ir other.sql'
refused w3.7 '\\include other.sql'
refused w3.8 '\\! id'
refused w3.9 '\\gexec'
refused w3.10 '\\set ON_ERROR_STOP 0'
refused w3.11 '   \\c other'
refused w3.12 '\t\\q'
refused w3.17 '\\\\\\c other'
refused w3.18 '\\.\\q'
refused w3.19 '\\C title'
refused w3.20 'SELECT 1;\n\\q'
refused w6.7 'SELECT 1; -- c\r\\gexec'
refused w6.8 '-- c\r\\q'
refused w7.7 '\\q \377'
refused w9.3 '\\q \377'
# a \restrict or \unrestrict line other than pg_dump's own pair: the strip rule refuses it
refused w3.13 '\\restrict Ab1Cd2Ef3 extra'
refused w3.14 ' \\restrict Ab1Cd2Ef3'
refused w3.15 '\\restrict'
refused w3.16 '\\unrestrict Ab1Cd2Ef3\\q'
refused d.restrict-line 'SELECT 1;\n\\restrict other'
refused d.cr-estrict-copy-value 'CREATE TABLE public.drill_cr (v text);\nCOPY public.drill_cr (v) FROM stdin;\n\\restrict-like value\n\\.'

# input that does not end where it should: refused (the check and COMMIT are swallowed, or
# psql ends without the sentinel)
refused b.open-quote "SELECT 'unterminated"
refused b.open-comment 'SELECT 1; /* unterminated'
# shellcheck disable=SC2016
refused d.open-dollar 'SELECT $$unterminated'
refused d.open-paren 'SELECT (1'
refused d.open-atomic 'CREATE FUNCTION public.fa() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1;'
refused d.dangling-view 'CREATE VIEW public.drill_dangling AS'
refused d.dangling-insert 'INSERT INTO public."User"'
refused d.dangling-commit 'COMMIT'
refused d.copy-without-end 'CREATE TABLE public.drill_swallow (v text);\nCOPY public.drill_swallow (v) FROM stdin;'
refused d.empty-after-copy 'CREATE TABLE public.drill_drain (v text);\nCOPY public.drill_drain (v) FROM stdin;\nrow\n\\.\n;'
loads_check d.copy-last 'CREATE TABLE public.drill_copy_last (v text);\nCOPY public.drill_copy_last (v) FROM stdin;\nlast row\n\\.' \
  'SELECT string_agg(v, $$,$$) FROM public.drill_copy_last' 'last row'

# legitimate content the earlier line check refused: it loads now
loads_same w4.8b '-- note: SELECT 1; COMMIT; here'
loads_check w4.8c "CREATE TABLE public.drill_s1 (v text);\nINSERT INTO public.drill_s1 VALUES ('a\nEND;\nb');" \
  "SELECT replace(v, E'\\n', '|') FROM public.drill_s1" 'a|END;|b'
loads_check w4.8d "CREATE TABLE public.drill_s2 (v text);\nINSERT INTO public.drill_s2 VALUES ('a\n\\\\q\nb');" \
  "SELECT replace(v, E'\\n', '|') FROM public.drill_s2" 'a|\q|b'
loads_check w4.9 'CREATE FUNCTION public.drill_f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 7;\nEND;\n$$;' \
  'SELECT public.drill_f()' 7

# NUL bytes: refused before anything else
refused w8.1 '\0\nCOMMIT;'
refused w8.3 '-- a\0b\nSELECT 1;'
refused w8.4 'SELECT 1;\n\\q\n\0'
refused k.nul-opens-comment '\0/*\nCOMMIT;\n-- */ ;'
{ cat "$corpus_base"; printf '\0'; } > "$WORK/case.sql"
run_refused w8.2 "$WORK/case.sql"

# whole-file variants of the dump
grep -v '^\\unrestrict ' "$corpus_base" > "$WORK/case.sql"; printf 'COMMIT;\n' >> "$WORK/case.sql"
run_refused w4.11 "$WORK/case.sql"
grep -v '^\\unrestrict ' "$corpus_base" > "$WORK/case.sql"; printf '\\q\n' >> "$WORK/case.sql"
run_refused w4.12 "$WORK/case.sql"
awk '{ if ($0 == "-- PostgreSQL database dump complete" || $0 == "") print; else printf "%s\r\n", $0 }' "$corpus_base" > "$WORK/case.sql"
run_refused e.crlf "$WORK/case.sql"
{ sed 's/^\\unrestrict/-- x unrestrict/' "$corpus_base"; printf 'CREATE TABLE public.fin(a int);\nCOPY public.fin FROM stdin;\n42\n\\.'; } > "$WORK/case.sql"
run_refused e.unpaired-restrict "$WORK/case.sql"
{ cat "$corpus_base"; printf 'CREATE TABLE public.fin(a int);\n-- trailing comment'; } > "$WORK/case.sql"
run_refused e.after-unrestrict "$WORK/case.sql"
{ printf 'SELECT 1;\n'; cat "$corpus_base"; } > "$WORK/case.sql"
run_refused e.statement-before-restrict "$WORK/case.sql"
# the same without the \restrict pair (a pg_dump before 16.10): they load
grep -v -E '^\\(un)?restrict ' "$corpus_base" > "$WORK/norestrict.sql"
{ cat "$WORK/norestrict.sql"; printf 'CREATE TABLE public.fin(a int);\nCOPY public.fin FROM stdin;\n42\n\\.'; } > "$WORK/case.sql"
drill_restore "$DST_DB" "$WORK/case.sql" --no-pre-backup
[ "$rc" -eq 0 ] || fail "corpus e.final-copy-end-no-newline: exit $rc: $(cat "$WORK/last.err")"
expect "corpus e.final-copy-end-no-newline" "$(sql "$DST_DB" 'SELECT a FROM public.fin')" 42
record e.final-copy-end-no-newline loads 0 'SELECT a FROM public.fin = 42'
{ cat "$WORK/norestrict.sql"; printf 'CREATE TABLE public.fin(a int);\r\nCOPY public.fin FROM stdin;\r\n42\r\n\\.\r'; } > "$WORK/case.sql"
drill_restore "$DST_DB" "$WORK/case.sql" --no-pre-backup
[ "$rc" -eq 0 ] || fail "corpus e.final-copy-end-cr: exit $rc: $(cat "$WORK/last.err")"
expect "corpus e.final-copy-end-cr" "$(sql "$DST_DB" 'SELECT a FROM public.fin')" 42
record e.final-copy-end-cr loads 0 'SELECT a FROM public.fin = 42'
{ cat "$WORK/norestrict.sql"; printf 'CREATE TABLE public.fin(a int);\n-- trailing comment'; } > "$WORK/case.sql"
drill_restore "$DST_DB" "$WORK/case.sql" --no-pre-backup
[ "$rc" -eq 0 ] || fail "corpus e.final-comment-no-newline: exit $rc: $(cat "$WORK/last.err")"
expect "corpus e.final-comment-no-newline" "$(sql "$DST_DB" "SELECT to_regclass('public.fin') IS NOT NULL")" t
record e.final-comment-no-newline loads 0 'public.fin exists'
drill_restore "$DST_DB" "$WORK/norestrict.sql" --no-pre-backup
[ "$rc" -eq 0 ] || fail "corpus e.no-restrict-pair: exit $rc: $(cat "$WORK/last.err")"
expect "corpus e.no-restrict-pair" "$(fingerprint "$DST_DB")" "$src_fp"
record e.no-restrict-pair loads 0 "same as the source"
fp_cur="$src_fp"

expect "corpus: side effects of \\! and \\o" "$("$REAL_DOCKER" exec "$DRILL_PG_CONTAINER" sh -c "test -e $SIDE_EFFECT && echo present || echo absent")" absent
expect "corpus: scratch databases left" "$(scratch_count)" 0
echo "drill: corpus outcomes (case, outcome, exit code, reason)"
sort -t "$(printf '\t')" -k 2,2 -k 1,1 "$WORK/corpus.tsv" | awk -F '\t' '{ printf "  %-28s %-8s %-3s %s\n", $1, $2, $3, $4 }'
echo "drill: $(grep -c . "$WORK/corpus.tsv") corpus cases, $(awk -F '\t' '$2 == "refused"' "$WORK/corpus.tsv" | wc -l | tr -d ' ') refused"
[ -z "${DRILL_REPORT:-}" ] || cp "$WORK/corpus.tsv" "$DRILL_REPORT"

for db in "$DST_DB" "$RICH_SRC" "$RICH_DST"; do sql postgres "DROP DATABASE $db" > /dev/null; done
echo "drill: PASSED"
