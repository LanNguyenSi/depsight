import { describe, it, expect } from "vitest";
import { registerCveTools } from "../tools/cves.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type Args = {
  repoId: string;
  minSeverity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  publishedAfter?: string;
};
type ToolHandler = (args: Args) => Promise<ToolResult>;

/** Capture the handler registerCveTools registers, mirroring the
 *  rescan.test.ts pattern: a fakeServer whose tool() stores the callback,
 *  a fakeClient whose getScan is the only method the handler touches. */
function captureCveHandler(getScan: (repoId: string) => Promise<unknown>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const fakeClient = { getScan } as unknown as DepsightClient;
  registerCveTools(fakeServer, fakeClient);
  if (!handler) throw new Error("registerCveTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const advisory = (over: Record<string, unknown>) => ({
  id: "CVE-1",
  severity: "HIGH",
  publishedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("depsight_get_cves tool", () => {
  it("returns the scan envelope plus filterApplied on success", async () => {
    const scan = {
      id: "scan-1",
      riskScore: 42,
      advisories: [advisory({ id: "CVE-A" }), advisory({ id: "CVE-B" })],
    };
    const handler = captureCveHandler(async () => ({ scan }));

    const result = await handler({ repoId: "repo-1" });

    expect(result.isError).toBeUndefined();
    const body = parseToolText(result);
    expect(body.success).toBe(true);
    expect(body.filterApplied).toEqual({
      minSeverity: undefined,
      publishedAfter: undefined,
    });
    expect((body.scan as { id: string }).id).toBe("scan-1");
    expect((body.scan as { advisories: unknown[] }).advisories).toHaveLength(2);
  });

  it("returns scan:null with an empty advisories list and message when no scan exists", async () => {
    const handler = captureCveHandler(async () => ({ scan: null }));

    const body = parseToolText(await handler({ repoId: "repo-1" }));

    expect(body).toEqual({
      success: true,
      scan: null,
      advisories: [],
      message: "No completed CVE scan found for this repo yet.",
    });
  });

  it("drops advisories below the requested minSeverity", async () => {
    const scan = {
      id: "scan-1",
      advisories: [
        advisory({ id: "CVE-crit", severity: "CRITICAL" }),
        advisory({ id: "CVE-high", severity: "HIGH" }),
        advisory({ id: "CVE-med", severity: "MEDIUM" }),
        advisory({ id: "CVE-low", severity: "LOW" }),
      ],
    };
    const handler = captureCveHandler(async () => ({ scan }));

    const body = parseToolText(await handler({ repoId: "repo-1", minSeverity: "HIGH" }));

    const ids = ((body.scan as { advisories: Array<{ id: string }> }).advisories).map(
      (a) => a.id,
    );
    expect(ids).toEqual(["CVE-crit", "CVE-high"]);
  });

  it("returns errResult for an unparseable publishedAfter", async () => {
    const handler = captureCveHandler(async () => ({
      scan: { id: "scan-1", advisories: [] },
    }));

    const result = await handler({ repoId: "repo-1", publishedAfter: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: 'publishedAfter is not a valid ISO 8601 date: "not-a-date"',
    });
  });

  it("excludes advisories with a missing or unparseable publishedAt when a cutoff is active", async () => {
    const scan = {
      id: "scan-1",
      advisories: [
        advisory({ id: "CVE-in-range", publishedAt: "2026-02-01T00:00:00Z" }),
        advisory({ id: "CVE-before-cutoff", publishedAt: "2020-01-01T00:00:00Z" }),
        advisory({ id: "CVE-missing-date", publishedAt: undefined }),
        advisory({ id: "CVE-bad-date", publishedAt: "not-a-date" }),
      ],
    };
    const handler = captureCveHandler(async () => ({ scan }));

    const body = parseToolText(
      await handler({ repoId: "repo-1", publishedAfter: "2026-01-01T00:00:00Z" }),
    );

    const ids = ((body.scan as { advisories: Array<{ id: string }> }).advisories).map(
      (a) => a.id,
    );
    expect(ids).toEqual(["CVE-in-range"]);
  });

  it("converts a client throw into an isError result", async () => {
    const handler = captureCveHandler(async () => {
      throw new Error("upstream unavailable");
    });

    const result = await handler({ repoId: "repo-1" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "upstream unavailable",
    });
  });
});
