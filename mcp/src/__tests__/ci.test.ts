import { describe, it, expect } from "vitest";
import { registerCiTools } from "../tools/ci.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type Args = {
  repoId?: string;
  type?: "fail-rate" | "build-times" | "flaky" | "bottleneck";
  period?: 1 | 7 | 30;
};
type ToolHandler = (args: Args) => Promise<ToolResult>;

function captureCiHandler(client: Partial<DepsightClient>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  registerCiTools(fakeServer, client as DepsightClient);
  if (!handler) throw new Error("registerCiTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_ci_analytics tool", () => {
  it("calls the repo-scoped analytics with the requested type and period", async () => {
    const data = { type: "flaky", results: [] };
    const handler = captureCiHandler({
      getCiAnalytics: async (repoId, type, period) => {
        expect(repoId).toBe("repo-1");
        expect(type).toBe("flaky");
        expect(period).toBe(7);
        return data;
      },
    });

    const result = await handler({ repoId: "repo-1", type: "flaky", period: 7 });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(data);
  });

  it("defaults type to fail-rate and period to 30 when repoId is provided but type/period are omitted", async () => {
    let seenType: string | undefined;
    let seenPeriod: number | undefined;
    const handler = captureCiHandler({
      getCiAnalytics: async (_repoId, type, period) => {
        seenType = type;
        seenPeriod = period;
        return { type, period };
      },
    });

    await handler({ repoId: "repo-1" });

    expect(seenType).toBe("fail-rate");
    expect(seenPeriod).toBe(30);
  });

  it("calls the cross-repo summary when repoId is omitted", async () => {
    const summary = { repos: [{ repoId: "repo-1", failRate: 0.1 }] };
    let seenPeriod: number | undefined;
    const handler = captureCiHandler({
      getCiAnalyticsCrossRepo: async (period) => {
        seenPeriod = period;
        return summary;
      },
    });

    const result = await handler({ period: 7 });

    expect(seenPeriod).toBe(7);
    expect(parseToolText(result)).toEqual(summary);
  });

  it("defaults period to 30 for the cross-repo summary when omitted", async () => {
    let seenPeriod: number | undefined;
    const handler = captureCiHandler({
      getCiAnalyticsCrossRepo: async (period) => {
        seenPeriod = period;
        return { repos: [] };
      },
    });

    await handler({});

    expect(seenPeriod).toBe(30);
  });

  it("converts a client throw into an isError result", async () => {
    const handler = captureCiHandler({
      getCiAnalytics: async () => {
        throw new Error("repo not tracked");
      },
    });

    const result = await handler({ repoId: "repo-untracked" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "repo not tracked",
    });
  });
});
