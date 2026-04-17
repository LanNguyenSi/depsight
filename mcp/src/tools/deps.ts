import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerDepsTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_get_deps",
    "Get the dependency-age report for a repo: which packages are up-to-date, outdated, major-behind, or deprecated, based on the latest dependency scan.",
    {
      repoId: z
        .string()
        .min(1)
        .describe("The depsight repo ID. Get it from depsight_list_repos."),
    },
    async ({ repoId }) => {
      try {
        const data = await client.getDeps(repoId);
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
