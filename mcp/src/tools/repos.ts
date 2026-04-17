import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerRepoTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_list_repos",
    "List the GitHub repositories the authenticated user has access to (via their GitHub token). Use this to discover `repoId` values that other depsight_* tools accept.",
    {},
    async () => {
      try {
        const data = await client.listRepos();
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.tool(
    "depsight_get_overview",
    "Team-health dashboard summary across all tracked repos: aggregate CVE counts, risk scores, license issues, and the top riskiest repos. No arguments.",
    {},
    async () => {
      try {
        const data = await client.getOverview();
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
