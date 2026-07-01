import { describe, it, expect } from "vitest";
import { registerDepsTools } from "../tools/deps.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: { repoId: string }) => Promise<ToolResult>;

function captureDepsHandler(getDeps: (repoId: string) => Promise<unknown>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const fakeClient = { getDeps } as unknown as DepsightClient;
  registerDepsTools(fakeServer, fakeClient);
  if (!handler) throw new Error("registerDepsTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_get_deps tool", () => {
  it("returns the client's dependency-age report unwrapped", async () => {
    const report = {
      repoId: "repo-1",
      dependencies: [{ name: "left-pad", status: "outdated" }],
    };
    const handler = captureDepsHandler(async (repoId) => {
      expect(repoId).toBe("repo-1");
      return report;
    });

    const result = await handler({ repoId: "repo-1" });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(report);
  });

  it("passes through an empty dependency list as-is", async () => {
    const report = { repoId: "repo-empty", dependencies: [] };
    const handler = captureDepsHandler(async () => report);

    const result = await handler({ repoId: "repo-empty" });

    expect(parseToolText(result)).toEqual(report);
  });

  it("converts a client throw into an isError result", async () => {
    const handler = captureDepsHandler(async () => {
      throw new Error("repo not found");
    });

    const result = await handler({ repoId: "repo-missing" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "repo not found",
    });
  });
});
