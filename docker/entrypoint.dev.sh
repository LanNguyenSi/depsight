#!/bin/sh
set -e

echo "==> Installing dependencies..."
npm install

echo "==> Generating Prisma client..."
npx prisma generate

echo "==> Pushing database schema..."
npm run db:push -- --skip-generate

echo "==> Starting dev server..."
exec npm run dev
