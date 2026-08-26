import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerRepoTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_list_repos",
    "List the GitHub repositories the authenticated user has access to (via their GitHub token). This is the live GitHub list, not depsight's tracked-repo set. Archived repos are excluded, matching depsight's own tracked repos, which are untracked (and excluded from scan/policy evaluation) once GitHub reports them as archived. Each entry's `id` is GitHub's numeric repo id, not a depsight `repoId`; obtain `repoId` values for the other depsight_* tools from depsight_get_overview.",
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
