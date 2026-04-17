import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
type Severity = (typeof SEVERITIES)[number];

function severityRank(s: string): number {
  const idx = SEVERITIES.indexOf(s.toUpperCase() as Severity);
  return idx === -1 ? 99 : idx;
}

export function registerCveTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_get_cves",
    "Get CVE advisories from the most recent completed CVE scan for a repo. Optionally filter by minimum severity and/or a publish-after cutoff. Returns the full scan envelope (counts, risk score) plus the filtered advisory list.",
    {
      repoId: z
        .string()
        .min(1)
        .describe("The depsight repo ID. Get it from depsight_list_repos."),
      minSeverity: z
        .enum(SEVERITIES)
        .optional()
        .describe("Only include advisories at or above this severity."),
      publishedAfter: z
        .string()
        .optional()
        .describe(
          "ISO 8601 date/time. Only include advisories published at or after this instant.",
        ),
    },
    async ({ repoId, minSeverity, publishedAfter }) => {
      try {
        const data = (await client.getScan(repoId)) as
          | { scan: null | { advisories: Array<Record<string, unknown>> } }
          | null
          | undefined;

        if (!data || !data.scan) {
          return ok({
            success: true,
            scan: null,
            advisories: [],
            message: "No completed CVE scan found for this repo yet.",
          });
        }

        const minRank =
          minSeverity !== undefined ? severityRank(minSeverity) : Infinity;
        const cutoff = publishedAfter ? Date.parse(publishedAfter) : null;
        if (publishedAfter && cutoff !== null && Number.isNaN(cutoff)) {
          return errResult(
            new Error(
              `publishedAfter is not a valid ISO 8601 date: "${publishedAfter}"`,
            ),
          );
        }

        const advisories = data.scan.advisories.filter((a) => {
          const sev = typeof a.severity === "string" ? a.severity : "";
          if (minSeverity !== undefined && severityRank(sev) > minRank) {
            return false;
          }
          if (cutoff !== null) {
            const published =
              typeof a.publishedAt === "string"
                ? Date.parse(a.publishedAt)
                : NaN;
            // An advisory with a missing or un-parseable publishedAt
            // is excluded when a cutoff is active — the caller asked
            // for "after this date" and we cannot prove it satisfies
            // that condition.
            if (Number.isNaN(published) || published < cutoff) return false;
          }
          return true;
        });

        return ok({
          success: true,
          scan: { ...data.scan, advisories },
          filterApplied: { minSeverity, publishedAfter },
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
