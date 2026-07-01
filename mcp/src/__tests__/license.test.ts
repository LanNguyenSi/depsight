import { describe, it, expect } from "vitest";
import { registerLicenseTools } from "../tools/license.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: { repoId: string }) => Promise<ToolResult>;

function captureLicenseHandler(getLicense: (repoId: string) => Promise<unknown>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const fakeClient = { getLicense } as unknown as DepsightClient;
  registerLicenseTools(fakeServer, fakeClient);
  if (!handler) throw new Error("registerLicenseTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_get_license_report tool", () => {
  it("returns the client's license report unwrapped", async () => {
    const report = {
      repoId: "repo-1",
      packages: [{ name: "gpl-lib", license: "GPL-3.0", violatesPolicy: true }],
      totals: { violations: 1 },
    };
    const handler = captureLicenseHandler(async (repoId) => {
      expect(repoId).toBe("repo-1");
      return report;
    });

    const result = await handler({ repoId: "repo-1" });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(report);
  });

  it("passes through a report with no violations as-is", async () => {
    const report = { repoId: "repo-clean", packages: [], totals: { violations: 0 } };
    const handler = captureLicenseHandler(async () => report);

    const result = await handler({ repoId: "repo-clean" });

    expect(parseToolText(result)).toEqual(report);
  });

  it("converts a client throw into an isError result", async () => {
    const handler = captureLicenseHandler(async () => {
      throw new Error("scan not found");
    });

    const result = await handler({ repoId: "repo-missing" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "scan not found",
    });
  });
});
