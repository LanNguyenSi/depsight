import { describe, it, expect } from "vitest";
import { registerSbomTools } from "../tools/sbom.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: { repoId: string }) => Promise<ToolResult>;

function captureSbomHandler(getSbom: (repoId: string) => Promise<unknown>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const fakeClient = { getSbom } as unknown as DepsightClient;
  registerSbomTools(fakeServer, fakeClient);
  if (!handler) throw new Error("registerSbomTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_get_sbom tool", () => {
  it("returns the client's CycloneDX SBOM unwrapped", async () => {
    const sbom = { bomFormat: "CycloneDX", specVersion: "1.4", components: [{ name: "left-pad" }] };
    const handler = captureSbomHandler(async (repoId) => {
      expect(repoId).toBe("repo-1");
      return sbom;
    });

    const result = await handler({ repoId: "repo-1" });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(sbom);
  });

  it("converts a no_scan 404 client throw into an isError result", async () => {
    const handler = captureSbomHandler(async () => {
      throw new Error("Depsight /api/sbom → HTTP 404: {\"error\":\"no_scan\"}");
    });

    const result = await handler({ repoId: "repo-unscanned" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: 'Depsight /api/sbom → HTTP 404: {"error":"no_scan"}',
    });
  });
});
