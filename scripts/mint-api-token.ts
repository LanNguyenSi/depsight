#!/usr/bin/env tsx
/**
 * CLI helper to mint a depsight API token (`dsat_…`) for a user.
 *
 * Usage:
 *   npx tsx scripts/mint-api-token.ts --user <userId> [--name <label>]
 *
 * Prints the raw token ONCE to stdout. The raw token is never stored
 * on the database (only the row). Losing it means revoking and
 * minting a new one — there is no retrieve-existing endpoint.
 *
 * Intended for operators wiring headless agents (e.g. the depsight
 * MCP server) to a specific user's data scope.
 */
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";

function parseArgs(): { userId?: string; name?: string } {
  const out: { userId?: string; name?: string } = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--user" || arg === "-u") out.userId = process.argv[++i];
    else if (arg === "--name" || arg === "-n") out.name = process.argv[++i];
  }
  return out;
}

async function main() {
  const { userId, name } = parseArgs();
  if (!userId) {
    console.error(
      "Usage: npx tsx scripts/mint-api-token.ts --user <userId> [--name <label>]",
    );
    process.exit(2);
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
    },
    select: { id: true, name: true, createdAt: true },
  });

  console.log(
    `Minted API token for user ${user.githubLogin ?? user.id} (id=${record.id}, name="${record.name}", created=${record.createdAt.toISOString()}).`,
  );
  console.log("Copy this token now — it will not be shown again:");
  console.log("");
  console.log(rawToken);
}

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
