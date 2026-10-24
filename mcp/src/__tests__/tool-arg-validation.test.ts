import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerCiTools } from "../tools/ci.js";
import { registerCveTools } from "../tools/cves.js";
import { registerDepsTools } from "../tools/deps.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// These tests pin the argument schemas each tool registers (the contract the
// server publishes in tools/list and uses to parse every call.args), so a zod
// major bump that changed an accept-set, an output value or the published JSON
// Schema is caught here rather than only in a live MCP client. The registered
// value is the raw ZodRawShape the SDK wraps into an object schema, so it is
// validated the same way (unknown keys stripped, non-optional fields required).
type Shape = Record<string, z.ZodType>;

function inputShape(
  register: (server: McpServer, client: DepsightClient) => void,
  toolName: string,
): z.ZodObject<Shape> {
  let shape: Shape | undefined;
  const fakeServer = {
    tool: (name: string, _desc: string, schema: Shape, _cb: unknown) => {
      if (name === toolName) shape = schema;
    },
  } as unknown as McpServer;
  register(fakeServer, {} as DepsightClient);
  if (!shape) throw new Error(`no input shape registered for ${toolName}`);
  return z.object(shape);
}

describe("depsight_ci_analytics argument schema (literal-union period)", () => {
  const schema = inputShape(registerCiTools, "depsight_ci_analytics");

  it("accepts period 1 and produces 1", () => {
    expect(schema.parse({ repoId: "r", period: 1 }).period).toBe(1);
  });

  it("accepts period 7 and produces 7", () => {
    expect(schema.parse({ repoId: "r", period: 7 }).period).toBe(7);
  });

  it("accepts period 30 and produces 30", () => {
    expect(schema.parse({ repoId: "r", period: 30 }).period).toBe(30);
  });

  it("rejects period 14 (not one of 1, 7, 30)", () => {
    expect(() => schema.parse({ repoId: "r", period: 14 })).toThrow();
  });

  it("rejects period '30' (string, not the numeric literal)", () => {
    expect(() => schema.parse({ repoId: "r", period: "30" })).toThrow();
  });

  it("omits period entirely (optional, not in required)", () => {
    const parsed = schema.parse({ repoId: "r" });
    expect(parsed.period).toBeUndefined();
    expect("period" in parsed).toBe(false);
  });

  it("rejects a non-allowlisted analytics type", () => {
    expect(() => schema.parse({ repoId: "r", type: "nope" })).toThrow();
  });

  it("publishes period as a numeric enum [1, 7, 30]", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: { period: { type?: string; enum?: unknown[] } };
    };
    expect(json.properties.period.type).toBe("number");
    expect(json.properties.period.enum).toEqual([1, 7, 30]);
  });
});

describe("depsight_get_cves argument schema (severity enum)", () => {
  const schema = inputShape(registerCveTools, "depsight_get_cves");

  it("accepts minSeverity HIGH and produces HIGH", () => {
    expect(schema.parse({ repoId: "r", minSeverity: "HIGH" }).minSeverity).toBe(
      "HIGH",
    );
  });

  it("accepts minSeverity CRITICAL and produces CRITICAL", () => {
    expect(
      schema.parse({ repoId: "r", minSeverity: "CRITICAL" }).minSeverity,
    ).toBe("CRITICAL");
  });

  it("rejects minSeverity 'MODERATE' (not in the enum)", () => {
    expect(() => schema.parse({ repoId: "r", minSeverity: "MODERATE" })).toThrow();
  });

  it("rejects minSeverity 'high' (enum is case sensitive)", () => {
    expect(() => schema.parse({ repoId: "r", minSeverity: "high" })).toThrow();
  });

  it("rejects an empty repoId (.min(1))", () => {
    expect(() => schema.parse({ repoId: "" })).toThrow();
  });

  it("rejects a missing repoId (required)", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("rejects a non-string repoId", () => {
    expect(() => schema.parse({ repoId: 7 })).toThrow();
  });

  it("publishes minSeverity as a string enum with the four severities", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: { minSeverity: { type?: string; enum?: unknown[] } };
    };
    expect(json.properties.minSeverity.type).toBe("string");
    expect(json.properties.minSeverity.enum).toEqual([
      "CRITICAL",
      "HIGH",
      "MEDIUM",
      "LOW",
    ]);
  });
});

describe("depsight_get_deps argument schema (required non-empty string)", () => {
  const schema = inputShape(registerDepsTools, "depsight_get_deps");

  it("accepts a non-empty repoId and produces it unchanged", () => {
    expect(schema.parse({ repoId: "repo-abc" }).repoId).toBe("repo-abc");
  });

  it("rejects an empty repoId (.min(1))", () => {
    expect(() => schema.parse({ repoId: "" })).toThrow();
  });

  it("rejects a missing repoId (required)", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("rejects a non-string repoId", () => {
    expect(() => schema.parse({ repoId: 42 })).toThrow();
  });

  it("publishes repoId as a string with minLength 1 and required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: { repoId: { type?: string; minLength?: number } };
      required?: string[];
    };
    expect(json.properties.repoId.type).toBe("string");
    expect(json.properties.repoId.minLength).toBe(1);
    expect(json.required).toContain("repoId");
  });
});

describe("object argument schema keeps stripping unknown keys (v3 parity)", () => {
  const schema = inputShape(registerDepsTools, "depsight_get_deps");

  it("accepts and strips an unrecognised extra property instead of rejecting", () => {
    const result = schema.safeParse({ repoId: "r", unexpected: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ repoId: "r" });
  });
});
