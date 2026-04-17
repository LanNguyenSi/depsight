import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

const PERIODS = [1, 7, 30] as const;

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
      period: z
        .enum(["1", "7", "30"])
        .optional()
        .describe("Lookback window in days. Default 30."),
    },
    async ({ repoId, type, period }) => {
      try {
        const parsedPeriod = (period ? Number(period) : 30) as
          | 1
          | 7
          | 30;
        const validPeriod = (PERIODS as readonly number[]).includes(
          parsedPeriod,
        )
          ? parsedPeriod
          : 30;

        if (!repoId) {
          const data = await client.getCiAnalyticsCrossRepo(validPeriod);
          return ok(data);
        }

        const data = await client.getCiAnalytics(
          repoId,
          type ?? "fail-rate",
          validPeriod,
        );
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
