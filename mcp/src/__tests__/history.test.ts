import { describe, it, expect } from "vitest";
import { registerHistoryTools } from "../tools/history.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: { repoId: string; limit?: number }) => Promise<ToolResult>;

function captureHistoryHandler(
  getHistory: (repoId: string, limit?: number) => Promise<unknown>,
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const fakeClient = { getHistory } as unknown as DepsightClient;
  registerHistoryTools(fakeServer, fakeClient);
  if (!handler) throw new Error("registerHistoryTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_get_history tool", () => {
  it("returns the client's history series unwrapped and forwards an explicit limit", async () => {
    const series = { repoId: "repo-1", points: [{ scanId: "scan-1", riskScore: 10 }] };
    let seenLimit: number | undefined;
    const handler = captureHistoryHandler(async (repoId, limit) => {
      expect(repoId).toBe("repo-1");
      seenLimit = limit;
      return series;
    });

    const result = await handler({ repoId: "repo-1", limit: 50 });

    expect(result.isError).toBeUndefined();
    expect(seenLimit).toBe(50);
    expect(parseToolText(result)).toEqual(series);
  });

  it("passes limit through as undefined when the caller omits it", async () => {
    let seenLimit: number | undefined = -1 as unknown as number;
    const handler = captureHistoryHandler(async (_repoId, limit) => {
      seenLimit = limit;
      return { repoId: "repo-1", points: [] };
    });

    await handler({ repoId: "repo-1" });

    expect(seenLimit).toBeUndefined();
  });

  it("converts a client throw into an isError result", async () => {
    const handler = captureHistoryHandler(async () => {
      throw new Error("no scans yet");
    });

    const result = await handler({ repoId: "repo-empty" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "no scans yet",
    });
  });
});
