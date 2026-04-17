import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerLicenseTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_get_license_report",
    "Get the license-compatibility report for a repo: per-package licenses, compatibility flags, policy violations, and totals.",
    {
      repoId: z
        .string()
        .min(1)
        .describe("The depsight repo ID. Get it from depsight_list_repos."),
    },
    async ({ repoId }) => {
      try {
        const data = await client.getLicense(repoId);
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
