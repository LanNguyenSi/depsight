import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerRescanTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_rescan",
    "Trigger a CVE scan for a tracked repository. The scan runs synchronously and returns a scanId plus status. After this call succeeds you can immediately call depsight_get_cves or depsight_evaluate_policy with the repoId to read fresh results.",
    {
      repoId: z
        .string()
        .min(1)
        .describe(
          "The depsight repo ID to scan. Get it from depsight_list_repos. An all-repos mode is not supported — scan each repo individually.",
        ),
    },
    async ({ repoId }) => {
      try {
        const data = (await client.rescan(repoId)) as {
          scanId?: string;
          status?: string;
          dependabotDisabled?: boolean;
        } | null;

        return ok({
          success: true,
          repoId,
          scanId: data?.scanId,
          status: data?.status ?? "completed",
          dependabotDisabled: data?.dependabotDisabled ?? false,
          message:
            "Scan completed. Call depsight_get_cves with this repoId to read updated CVE results.",
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
