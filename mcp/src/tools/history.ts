import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerHistoryTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_get_history",
    "Get the CVE-scan history (time series of risk scores and CVE counts) for a repo. Useful for trend analysis.",
    {
      repoId: z
        .string()
        .min(1)
        .describe("The depsight repo ID. Get it from depsight_list_repos."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of past scans to return (default 30, max 100)."),
    },
    async ({ repoId, limit }) => {
      try {
        const data = await client.getHistory(repoId, limit);
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
