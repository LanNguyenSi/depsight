#!/usr/bin/env bash
# Restore drill: proves that scripts/backup.sh and scripts/restore.sh round-trip a
# real database. Runs in CI against a throwaway Postgres 16 and can be run by hand
# against any scratch Postgres container; never point it at production.
#
# It applies the schema the way the hosted `migrate` service does (the pre-push
# SQL, then `prisma db push`), seeds a few rows, runs the REAL scripts/backup.sh,
# restores the dump with the REAL scripts/restore.sh into a second, freshly
# created database, and asserts row counts, one row's content and the Advisory
# unique index. The scripts see a `docker` shim that maps
# `docker compose -f <file> exec -T db <cmd>` onto `docker exec -i <container> <cmd>`,
# so every pg_dump and psql option comes from the scripts themselves: if their
# options drift, this drill fails.
#
# Usage:
#   DRILL_PG_CONTAINER=<container of a postgres:16 started with user/db depsight> \
#   DRILL_DATABASE_URL=postgresql://depsight:<password>@127.0.0.1:<port>/depsight \
#   scripts/restore-drill.sh
# Run it from anywhere; it uses the checkout it lives in (needs `npm ci` done).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DRILL_PG_CONTAINER:?set DRILL_PG_CONTAINER to the scratch Postgres container}"
: "${DRILL_DATABASE_URL:?set DRILL_DATABASE_URL to the connection URL of its depsight database}"
SRC_DB=depsight
DST_DB=depsight_restored
EXPECT_USERS=2
EXPECT_REPOS=3
EXPECT_FULLNAME='drill/restored-repo'

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
      exec "$REAL_DOCKER" exec -i "$DRILL_PG_CONTAINER" "\$@"
      ;;
  esac
fi
echo "drill docker shim: unexpected call: \$*" >&2
exit 9
SHIM
chmod +x "$WORK/bin/docker"

sql() { # sql <database> <statement>: print the bare result
  "$REAL_DOCKER" exec -i -e PGOPTIONS='-c client_min_messages=warning' "$DRILL_PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U depsight -d "$1" -tA -c "$2"
}
fail() { echo "drill: FAIL: $*" >&2; exit 1; }
expect() { # expect <label> <actual> <expected>
  [ "$2" = "$3" ] || fail "$1: got '$2', expected '$3'"
  echo "drill: ok: $1 = $3"
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
  ('drill-u2', '9002', 'drill-two', 'tok-two', now())" > /dev/null
sql "$SRC_DB" "INSERT INTO \"Repo\" (id, \"userId\", \"githubId\", owner, name, \"fullName\", \"updatedAt\") VALUES
  ('drill-r1', 'drill-u1', 1, 'drill', 'one', 'drill/one', now()),
  ('drill-r2', 'drill-u1', 2, 'drill', 'two', 'drill/two', now()),
  ('drill-r3', 'drill-u2', 3, 'drill', 'restored-repo', '$EXPECT_FULLNAME', now())" > /dev/null
expect "seeded users" "$(sql "$SRC_DB" 'SELECT count(*) FROM "User"')" "$EXPECT_USERS"

echo "drill: backup.sh"
PATH="$WORK/bin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" BACKUP_DIR="$WORK/backups" \
  PG_DB="$SRC_DB" "$REPO_ROOT/scripts/backup.sh"
dump="$(find "$WORK/backups" -maxdepth 1 -name 'depsight-*.sql')"
[ -n "$dump" ] && [ "$(wc -l <<< "$dump" | tr -d ' ')" = 1 ] || fail "expected exactly one dump in $WORK/backups"

echo "drill: restore.sh into a fresh database"
sql postgres "DROP DATABASE IF EXISTS $DST_DB" > /dev/null
sql postgres "CREATE DATABASE $DST_DB OWNER depsight" > /dev/null
PATH="$WORK/bin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" RESTORE_APP_SERVICE='' \
  PG_DB="$DST_DB" "$REPO_ROOT/scripts/restore.sh" --yes "$dump"

echo "drill: asserting the restored database"
expect "restored users" "$(sql "$DST_DB" 'SELECT count(*) FROM "User"')" "$EXPECT_USERS"
expect "restored repos" "$(sql "$DST_DB" 'SELECT count(*) FROM "Repo"')" "$EXPECT_REPOS"
expect "restored row content" \
  "$(sql "$DST_DB" "SELECT \"fullName\" || '|' || \"userId\" FROM \"Repo\" WHERE id = 'drill-r3'")" \
  "$EXPECT_FULLNAME|drill-u2"
expect "restored token" "$(sql "$DST_DB" "SELECT \"githubToken\" FROM \"User\" WHERE id = 'drill-u2'")" "tok-two"
expect "advisory unique index" \
  "$(sql "$DST_DB" "SELECT count(*) FROM pg_indexes WHERE tablename = 'Advisory' AND indexdef LIKE '%UNIQUE%scanId%ghsaId%packageName%'")" 1

echo "drill: a failing restore must leave the database unchanged"
# The statements before the failure would be committed (and the rows gone) if the
# restore were not one transaction.
awk '/^-- PostgreSQL database dump complete/ { print "DELETE FROM public.\"Repo\";"; print "SELECT 1/0;" } { print }' \
  "$dump" > "$WORK/broken.sql"
if PATH="$WORK/bin:$PATH" BACKUP_COMPOSE_FILE="$WORK/compose.yml" RESTORE_APP_SERVICE='' \
  PG_DB="$DST_DB" "$REPO_ROOT/scripts/restore.sh" --yes "$WORK/broken.sql" 2> "$WORK/broken.err"; then
  fail "restore.sh accepted a dump that fails half way"
fi
grep -q 'division by zero' "$WORK/broken.err" || fail "broken dump failed for another reason: $(cat "$WORK/broken.err")"
expect "repos after failed restore" "$(sql "$DST_DB" 'SELECT count(*) FROM "Repo"')" "$EXPECT_REPOS"

sql postgres "DROP DATABASE $DST_DB" > /dev/null
echo "drill: PASSED"
