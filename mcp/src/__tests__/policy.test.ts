import { describe, it, expect } from "vitest";
import { registerPolicyTools } from "../tools/policy.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ListHandler = (args: Record<string, never>) => Promise<ToolResult>;
type EvaluateHandler = (args: { scanId: string }) => Promise<ToolResult>;

/** registerPolicyTools registers TWO tools (depsight_list_policies,
 *  depsight_evaluate_policy) — capture both by name. */
function capturePolicyHandlers(
  client: Partial<DepsightClient>,
): { list: ListHandler; evaluate: EvaluateHandler } {
  const handlers: Record<string, ListHandler | EvaluateHandler> = {};
  const fakeServer = {
    tool: (
      name: string,
      _desc: string,
      _schema: unknown,
      cb: ListHandler | EvaluateHandler,
    ) => {
      handlers[name] = cb;
    },
  } as unknown as McpServer;
  registerPolicyTools(fakeServer, client as DepsightClient);
  return {
    list: handlers["depsight_list_policies"] as ListHandler,
    evaluate: handlers["depsight_evaluate_policy"] as EvaluateHandler,
  };
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("depsight_list_policies tool", () => {
  it("returns the client's policy list unwrapped", async () => {
    const policies = [
      { id: "pol-1", name: "No GPL", type: "LICENSE_DENY", enabled: true },
    ];
    const { list } = capturePolicyHandlers({ listPolicies: async () => policies });

    const result = await list({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(policies);
  });

  it("converts a client throw into an isError result", async () => {
    const { list } = capturePolicyHandlers({
      listPolicies: async () => {
        throw new Error("unauthorized");
      },
    });

    const result = await list({});

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "unauthorized",
    });
  });
});

describe("depsight_evaluate_policy tool", () => {
  it("returns the client's evaluation payload unwrapped for a scanId", async () => {
    const evaluation = { violations: [{ policyId: "pol-1", package: "left-pad" }], count: 1 };
    const { evaluate } = capturePolicyHandlers({
      evaluatePolicy: async (scanId) => {
        expect(scanId).toBe("scan-1");
        return evaluation;
      },
    });

    const result = await evaluate({ scanId: "scan-1" });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(evaluation);
  });

  it("passes through a zero-violation evaluation as-is", async () => {
    const evaluation = { violations: [], count: 0 };
    const { evaluate } = capturePolicyHandlers({ evaluatePolicy: async () => evaluation });

    const result = await evaluate({ scanId: "scan-1" });

    expect(parseToolText(result)).toEqual(evaluation);
  });

  it("converts a client throw into an isError result", async () => {
    const { evaluate } = capturePolicyHandlers({
      evaluatePolicy: async () => {
        throw new Error("scan not found");
      },
    });

    const result = await evaluate({ scanId: "scan-missing" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "scan not found",
    });
  });
});
