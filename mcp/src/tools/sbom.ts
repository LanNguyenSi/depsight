import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerSbomTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_get_sbom",
    "Export the CycloneDX 1.4 Software Bill of Materials (SBOM) for a repo. Requires a completed scan to exist for the repo — the API returns 404 with error 'no_scan' if none is found; run a CVE scan first in that case. Use depsight_list_repos to obtain the repoId.",
    {
      repoId: z
        .string()
        .min(1)
        .describe(
          "The depsight repo ID. Obtain it from depsight_list_repos (id field).",
        ),
    },
    async ({ repoId }) => {
      try {
        const data = await client.getSbom(repoId);
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
