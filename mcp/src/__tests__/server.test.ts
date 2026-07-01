import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, startServer } from "../server.js";

// registerXTools() calls `server.tool(name, ...)` for each real McpServer
// instance created by `new McpServer(...)`. Mock the SDK's McpServer with a
// fake that records every registered tool name, and the SDK's transport with
// a fake whose instances we can assert server.connect() was called with.
// vi.mock() calls are hoisted above these imports by vitest, so the fakes
// below are in place before server.ts (imported above) is evaluated.
let registeredTools: string[] = [];
const connectMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: vi.fn().mockImplementation(function FakeMcpServer() {
      return {
        tool: (name: string) => {
          registeredTools.push(name);
        },
        connect: connectMock,
      };
    }),
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  return {
    StdioServerTransport: vi.fn().mockImplementation(function FakeStdioServerTransport() {
      return { __fake: "transport" };
    }),
  };
});

const CONFIG = { gatewayUrl: "https://depsight.example.com", apiToken: "dsat_test" };

const EXPECTED_TOOL_NAMES = [
  "depsight_list_repos",
  "depsight_get_overview",
  "depsight_get_cves",
  "depsight_get_deps",
  "depsight_get_license_report",
  "depsight_get_history",
  "depsight_list_policies",
  "depsight_evaluate_policy",
  "depsight_ci_analytics",
  "depsight_get_sbom",
  "depsight_rescan",
];

describe("createServer", () => {
  beforeEach(() => {
    registeredTools = [];
    vi.clearAllMocks();
  });

  it("registers every depsight_* tool exactly once", () => {
    createServer(CONFIG);

    expect(registeredTools.sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(registeredTools).toHaveLength(EXPECTED_TOOL_NAMES.length);
  });

  it("constructs the McpServer with the depsight name/version", () => {
    createServer(CONFIG);

    expect(McpServer).toHaveBeenCalledWith({ name: "depsight", version: "0.3.0" });
  });
});

describe("startServer", () => {
  beforeEach(() => {
    registeredTools = [];
    vi.clearAllMocks();
  });

  it("creates a StdioServerTransport and connects the server to it", async () => {
    await startServer(CONFIG);

    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith({ __fake: "transport" });
  });
});
