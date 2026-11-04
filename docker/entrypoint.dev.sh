#!/bin/sh
set -e

echo "==> Installing dependencies..."
npm install

echo "==> Generating Prisma client..."
npx prisma generate

echo "==> Pushing database schema..."
npm run db:push -- --skip-generate

# `docker compose run --rm app <command>` (what the Makefile's RUN variable does)
# arrives here as the arguments. Run it instead of the dev server; with no
# arguments (`docker compose up`) start the dev server as before. The quoted "$@"
# keeps one argument per word, so `sh -c 'npm run lint && npx tsc --noEmit'`
# reaches sh as one command string.
if [ "$#" -gt 0 ]; then
  echo "==> Running command: $*"
  exec "$@"
fi

echo "==> Starting dev server..."
exec npm run dev
