import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerPolicyTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_evaluate_policy",
    "Evaluate the user's enabled policies (LICENSE_DENY, LICENSE_ALLOW_ONLY, CVE_MIN_SEVERITY, DEPENDENCY_MAX_AGE) against a specific scan. Read-only — does not mutate state. Returns the violations with affected packages.",
    {
      scanId: z
        .string()
        .min(1)
        .describe(
          "The scan ID to evaluate. Get it from depsight_get_cves (scan.id) or depsight_get_deps (scanId).",
        ),
    },
    async ({ scanId }) => {
      try {
        const data = await client.evaluatePolicy(scanId);
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
