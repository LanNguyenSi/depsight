import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export function registerPolicyTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_list_policies",
    "List the user's configured dependency policies. Returns each policy's name, type (LICENSE_DENY, LICENSE_ALLOW_ONLY, CVE_MIN_SEVERITY, DEPENDENCY_MAX_AGE), rule object, severity, and enabled flag. Use this before depsight_evaluate_policy to see which policies are active.",
    {},
    async () => {
      try {
        const data = await client.listPolicies();
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );

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
