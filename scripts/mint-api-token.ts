#!/usr/bin/env tsx
/**
 * CLI helper to mint a depsight API token (`dsat_…`) for a user.
 *
 * Usage:
 *   npx tsx scripts/mint-api-token.ts --user <userId> [--name <label>] [--scope READ|WRITE]
 *
 * --scope defaults to WRITE (full read+write access), matching this
 * script's behaviour before the scope field existed. Pass `--scope READ`
 * to mint a read-only token, e.g. for a headless agent that should not be
 * able to trigger scans or mutate policies.
 *
 * Prints the raw token ONCE to stdout. The raw token is never stored
 * on the database (only the row). Losing it means revoking and
 * minting a new one — there is no retrieve-existing endpoint.
 *
 * Intended for operators wiring headless agents (e.g. the depsight
 * MCP server) to a specific user's data scope.
 */
import crypto from "node:crypto";
import { ApiTokenScope } from "@prisma/client";
import { prisma } from "../lib/prisma";

const USAGE =
  "Usage: npx tsx scripts/mint-api-token.ts --user <userId> [--name <label>] [--scope READ|WRITE] (scope defaults to WRITE)";

export function parseArgs(): { userId?: string; name?: string; scope?: string } {
  const out: { userId?: string; name?: string; scope?: string } = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--user" || arg === "-u") out.userId = process.argv[++i];
    else if (arg === "--name" || arg === "-n") out.name = process.argv[++i];
    else if (arg === "--scope" || arg === "-s") out.scope = process.argv[++i];
  }
  return out;
}

export async function main() {
  const { userId, name, scope } = parseArgs();
  if (!userId) {
    console.error(USAGE);
    process.exit(2);
  }

  let resolvedScope: ApiTokenScope = ApiTokenScope.WRITE;
  if (scope !== undefined) {
    if (!Object.values(ApiTokenScope).includes(scope as ApiTokenScope)) {
      console.error(`Invalid --scope: "${scope}" (expected READ or WRITE)`);
      process.exit(2);
    }
    resolvedScope = scope as ApiTokenScope;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, githubLogin: true },
  });
  if (!user) {
    console.error(`User not found: ${userId}`);
    process.exit(1);
  }

  const rawToken = "dsat_" + crypto.randomBytes(32).toString("hex");
  const label = name ?? `cli-${new Date().toISOString().slice(0, 10)}`;

  const record = await prisma.apiToken.create({
    data: {
      userId: user.id,
      token: rawToken,
      name: label,
      scope: resolvedScope,
    },
    select: { id: true, name: true, scope: true, createdAt: true },
  });

  console.log(
    `Minted API token for user ${user.githubLogin ?? user.id} (id=${record.id}, name="${record.name}", scope=${record.scope}, created=${record.createdAt.toISOString()}).`,
  );
  console.log("Copy this token now — it will not be shown again:");
  console.log("");
  console.log(rawToken);
}

// Only auto-run when this file is the process entry point (`npx tsx
// scripts/mint-api-token.ts ...`), not when imported (e.g. by tests). The
// package has no "type": "module" in package.json, so it runs under the
// default CommonJS module system — `require.main === module` is the correct
// entry-point guard here (rather than the ESM `import.meta.url` idiom).
if (require.main === module) {
  main()
    .catch((err) => {
      // Print only the message — the full Prisma error object can leak
      // the DATABASE_URL in its meta fields.
      const message = err instanceof Error ? err.message : String(err);
      console.error("mint-api-token failed:", message);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
