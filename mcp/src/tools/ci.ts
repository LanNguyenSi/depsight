import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

export const ciPeriodSchema = z
  .union([z.literal(1), z.literal(7), z.literal(30)])
  .optional();

export function registerCiTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_ci_analytics",
    "GitHub Actions CI insights. When `repoId` is provided, returns per-repo data for the chosen analytics `type` (fail-rate / build-times / flaky / bottleneck). When `repoId` is omitted, returns cross-repo health summaries across all tracked repos.",
    {
      repoId: z
        .string()
        .optional()
        .describe(
          "Optional: the depsight repo ID. Omit to get cross-repo summaries.",
        ),
      type: z
        .enum(["fail-rate", "build-times", "flaky", "bottleneck"])
        .optional()
        .describe(
          "Analytics type (repo-scoped only, default fail-rate). Ignored for cross-repo queries.",
        ),
      period: ciPeriodSchema.describe("Lookback window in days. Default 30."),
    },
    async ({ repoId, type, period }) => {
      try {
        const resolvedPeriod = period ?? 30;

        if (!repoId) {
          const data = await client.getCiAnalyticsCrossRepo(resolvedPeriod);
          return ok(data);
        }

        const data = await client.getCiAnalytics(
          repoId,
          type ?? "fail-rate",
          resolvedPeriod,
        );
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
