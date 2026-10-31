import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RateLimitError, type DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

type CveScanData = {
  scanId?: string;
  status?: string;
  dependabotDisabled?: boolean;
  degradedReason?: string | null;
} | null;

type DepsScanData = {
  scanId?: string;
  summary?: unknown;
} | null;

const DEPS_MESSAGE =
  "Dependency-age scan completed. Call depsight_get_deps with this repoId to read the fresh dependency-age results.";

function cveFields(data: CveScanData): {
  scanId: string | undefined;
  status: string;
  dependabotDisabled: boolean;
  degradedReason: string | null;
} {
  return {
    scanId: data?.scanId,
    status: data?.status ?? "completed",
    dependabotDisabled: data?.dependabotDisabled ?? false,
    degradedReason: data?.degradedReason ?? null,
  };
}

function cveMessage(status: string, degradedReason: string | null): string {
  return status === "running"
    ? "A scan is already in progress for this repository. Call depsight_get_cves with this repoId once it completes to read updated CVE results."
    : degradedReason !== null
      ? "Scan completed but degraded: a source could not be read, so the result may be incomplete (see degradedReason). Call depsight_get_cves with this repoId to read the partial CVE results."
      : "Scan completed. Call depsight_get_cves with this repoId to read updated CVE results.";
}

export function registerRescanTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_rescan",
    'Trigger a synchronous scan for a tracked repository and return its scanId plus status. target "cves" (the default when omitted) refreshes CVE data via POST /api/scan; target "deps" refreshes the dependency-age data via POST /api/deps and requires a WRITE-scoped token; target "all" runs the CVE scan first and then the dependency-age scan. After a "cves" or "all" call succeeds you can immediately call depsight_get_cves or depsight_evaluate_policy with the repoId to read fresh CVE results; after "deps" or "all" succeeds, depsight_get_deps returns the fresh dependency-age scan.',
    {
      repoId: z
        .string()
        .min(1)
        .describe(
          "The depsight repo ID to scan. Get it from depsight_list_repos (repoId field, not id). An all-repos mode is not supported; scan each repo individually.",
        ),
      target: z
        .enum(["cves", "deps", "all"])
        .optional()
        .describe(
          'What to refresh: "cves" (default) runs the CVE scan only, "deps" runs the dependency-age scan only (requires a WRITE-scoped token), "all" runs the CVE scan and then the dependency-age scan.',
        ),
    },
    async ({ repoId, target }) => {
      const t = target ?? "cves";
      try {
        if (t === "deps") {
          const depsData = (await client.rescanDeps(repoId)) as DepsScanData;
          return ok({
            success: true,
            repoId,
            target: t,
            depsScanId: depsData?.scanId,
            depsSummary: depsData?.summary ?? null,
            message: DEPS_MESSAGE,
          });
        }

        if (t === "all") {
          const data = (await client.rescan(repoId)) as CveScanData;
          const cve = cveFields(data);
          const message = cveMessage(cve.status, cve.degradedReason);
          try {
            const depsData = (await client.rescanDeps(repoId)) as DepsScanData;
            return ok({
              success: true,
              repoId,
              target: t,
              ...cve,
              depsScanId: depsData?.scanId,
              depsSummary: depsData?.summary ?? null,
              message: `${message} ${DEPS_MESSAGE}`,
            });
          } catch (depsErr) {
            const cause =
              depsErr instanceof Error ? depsErr.message : String(depsErr);
            const body: Record<string, unknown> = {
              success: false,
              repoId,
              target: t,
              ...cve,
              error: `The CVE scan completed and its results stand (see scanId, status, degradedReason), but the dependency-age scan failed, so depsight_get_deps was not refreshed and still returns data from before this call. Call depsight_get_cves with this repoId to read the updated CVE results. Cause: ${cause}`,
            };
            if (depsErr instanceof RateLimitError) {
              body.retryAfterSeconds = depsErr.retryAfterSeconds;
            }
            return {
              content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
              isError: true,
            };
          }
        }

        const data = (await client.rescan(repoId)) as CveScanData;
        const cve = cveFields(data);
        return ok({
          success: true,
          repoId,
          ...cve,
          message: cveMessage(cve.status, cve.degradedReason),
        });
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
