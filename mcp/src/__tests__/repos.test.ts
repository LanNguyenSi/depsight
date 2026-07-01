import { describe, it, expect } from "vitest";
import { registerRepoTools } from "../tools/repos.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: Record<string, never>) => Promise<ToolResult>;

/** registerRepoTools registers TWO tools (depsight_list_repos,
 *  depsight_get_overview) — capture both by name, mirroring the
 *  rescan.test.ts fakeServer pattern. */
function captureRepoHandlers(client: Partial<DepsightClient>): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handlers[name] = cb;
    },
  } as unknown as McpServer;
  registerRepoTools(fakeServer, client as DepsightClient);
  return handlers;
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_list_repos tool", () => {
  it("returns the client's repo list unwrapped", async () => {
    const repos = [{ id: "repo-1", name: "acme/widgets" }];
    const handlers = captureRepoHandlers({ listRepos: async () => repos });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(repos);
  });

  it("converts a client throw into an isError result", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => {
        throw new Error("gateway down");
      },
    });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "gateway down",
    });
  });
});

describe("depsight_get_overview tool", () => {
  it("returns the client's overview payload unwrapped", async () => {
    const overview = { totalRepos: 3, totalCves: 12, riskiestRepos: [] };
    const handlers = captureRepoHandlers({ getOverview: async () => overview });

    const result = await handlers["depsight_get_overview"]({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(overview);
  });

  it("converts a client throw into an isError result", async () => {
    const handlers = captureRepoHandlers({
      getOverview: async () => {
        throw new Error("unauthorized");
      },
    });

    const result = await handlers["depsight_get_overview"]({});

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "unauthorized",
    });
  });
});
