import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerCiTools } from "../tools/ci.js";
import { registerCveTools } from "../tools/cves.js";
import { registerDepsTools } from "../tools/deps.js";
import { registerRescanTools } from "../tools/rescan.js";
import { registerHistoryTools } from "../tools/history.js";
import { registerLicenseTools } from "../tools/license.js";
import { registerSbomTools } from "../tools/sbom.js";
import { registerPolicyTools } from "../tools/policy.js";
import { registerRepoTools } from "../tools/repos.js";
import { TOOL_REGISTRARS } from "../server.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// These tests pin the argument schemas each tool registers (the contract the
// server publishes in tools/list and uses to parse every call.args), so a zod
// major bump that changed an accept-set, an output value or the published JSON
// Schema is caught here rather than only in a live MCP client. The registered
// value is the raw ZodRawShape the SDK wraps into an object schema, so it is
// validated the same way (unknown keys stripped, non-optional fields required).
type Shape = Record<string, z.ZodType>;

// Every tool-name whose argument schema this file pins, recorded by
// inputShape() while the describes below are collected. The guard describe at
// the bottom compares this set against the names TOOL_REGISTRARS (server.ts,
// the list createServer iterates) registers against a recording fake server,
// so a newly registered tool without argument tests here fails the suite.
const coveredToolNames = new Set<string>();

function inputShape(
  register: (server: McpServer, client: DepsightClient) => void,
  toolName: string,
): z.ZodObject<Shape> {
  let shape: Shape | undefined;
  const fakeServer = {
    tool: (name: string, _desc: string, schema: Shape) => {
      if (name === toolName) shape = schema;
    },
  } as unknown as McpServer;
  register(fakeServer, {} as DepsightClient);
  if (!shape) throw new Error(`no input shape registered for ${toolName}`);
  coveredToolNames.add(toolName);
  return z.object(shape);
}

describe("depsight_ci_analytics argument schema (multi-value literal period)", () => {
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

  it("omits repoId entirely (optional; the handler answers cross-repo summaries)", () => {
    const parsed = schema.parse({ period: 30 });
    expect(parsed.repoId).toBeUndefined();
    expect("repoId" in parsed).toBe(false);
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

  it("publishes repoId as optional (not in required)", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      required?: string[];
    };
    expect(json.required ?? []).not.toContain("repoId");
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

describe("depsight_rescan argument schema (optional target enum)", () => {
  const schema = inputShape(registerRescanTools, "depsight_rescan");

  it('accepts target "cves" and produces it unchanged', () => {
    expect(schema.parse({ repoId: "r", target: "cves" }).target).toBe("cves");
  });

  it('accepts target "deps" and produces it unchanged', () => {
    expect(schema.parse({ repoId: "r", target: "deps" }).target).toBe("deps");
  });

  it('accepts target "all" and produces it unchanged', () => {
    expect(schema.parse({ repoId: "r", target: "all" }).target).toBe("all");
  });

  it("omits target entirely (optional; the handler defaults it to cves)", () => {
    const parsed = schema.parse({ repoId: "r" });
    expect(parsed.target).toBeUndefined();
    expect("target" in parsed).toBe(false);
  });

  it('rejects target "dependencies" (not in the enum)', () => {
    expect(() => schema.parse({ repoId: "r", target: "dependencies" })).toThrow();
  });

  it('rejects target "CVEs" (enum is case sensitive)', () => {
    expect(() => schema.parse({ repoId: "r", target: "CVEs" })).toThrow();
  });

  it("rejects an empty-string target", () => {
    expect(() => schema.parse({ repoId: "r", target: "" })).toThrow();
  });

  it("rejects a non-string target", () => {
    expect(() => schema.parse({ repoId: "r", target: 3 })).toThrow();
  });

  it("publishes target as an optional string enum [cves, deps, all] and repoId as required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: { target: { type?: string; enum?: unknown[] } };
      required?: string[];
    };
    expect(json.properties.target.type).toBe("string");
    expect(json.properties.target.enum).toEqual(["cves", "deps", "all"]);
    expect(json.required).toContain("repoId");
    expect(json.required ?? []).not.toContain("target");
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

describe("depsight_get_history argument schema (bounded integer limit)", () => {
  const schema = inputShape(registerHistoryTools, "depsight_get_history");

  it("accepts a non-empty repoId and produces it unchanged", () => {
    expect(schema.parse({ repoId: "repo-abc" }).repoId).toBe("repo-abc");
  });

  it("rejects an empty repoId (.min(1))", () => {
    expect(() => schema.parse({ repoId: "" })).toThrow();
  });

  it("rejects a missing repoId (required)", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("accepts limit 1 (the minimum)", () => {
    expect(schema.parse({ repoId: "r", limit: 1 }).limit).toBe(1);
  });

  it("accepts limit 100 (the maximum)", () => {
    expect(schema.parse({ repoId: "r", limit: 100 }).limit).toBe(100);
  });

  it("rejects limit 0 (below the minimum)", () => {
    expect(() => schema.parse({ repoId: "r", limit: 0 })).toThrow();
  });

  it("rejects limit 101 (above the maximum)", () => {
    expect(() => schema.parse({ repoId: "r", limit: 101 })).toThrow();
  });

  it("rejects limit 1.5 (not an integer)", () => {
    expect(() => schema.parse({ repoId: "r", limit: 1.5 })).toThrow();
  });

  it("rejects limit NaN (a number value, but not a usable count)", () => {
    expect(() => schema.parse({ repoId: "r", limit: Number.NaN })).toThrow();
  });

  it('rejects limit "5" (string, not the number)', () => {
    expect(() => schema.parse({ repoId: "r", limit: "5" })).toThrow();
  });

  it("omits limit entirely (optional; the backend applies its own default)", () => {
    const parsed = schema.parse({ repoId: "r" });
    expect(parsed.limit).toBeUndefined();
    expect("limit" in parsed).toBe(false);
  });

  it("publishes limit as an optional integer in [1, 100] and repoId as required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: {
        repoId: { type?: string; minLength?: number };
        limit: { type?: string; minimum?: number; maximum?: number };
      };
      required?: string[];
    };
    expect(json.properties.repoId.type).toBe("string");
    expect(json.properties.repoId.minLength).toBe(1);
    expect(json.properties.limit.type).toBe("integer");
    expect(json.properties.limit.minimum).toBe(1);
    expect(json.properties.limit.maximum).toBe(100);
    expect(json.required).toContain("repoId");
    expect(json.required ?? []).not.toContain("limit");
  });
});

describe("depsight_get_license_report argument schema (required non-empty string)", () => {
  const schema = inputShape(registerLicenseTools, "depsight_get_license_report");

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

describe("depsight_get_sbom argument schema (required non-empty string)", () => {
  const schema = inputShape(registerSbomTools, "depsight_get_sbom");

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

describe("depsight_evaluate_policy argument schema (required non-empty scanId)", () => {
  const schema = inputShape(registerPolicyTools, "depsight_evaluate_policy");

  it("accepts a non-empty scanId and produces it unchanged", () => {
    expect(schema.parse({ scanId: "scan-abc" }).scanId).toBe("scan-abc");
  });

  it("rejects an empty scanId (.min(1))", () => {
    expect(() => schema.parse({ scanId: "" })).toThrow();
  });

  it("rejects a missing scanId (required)", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("rejects a non-string scanId", () => {
    expect(() => schema.parse({ scanId: 42 })).toThrow();
  });

  it("publishes scanId as a string with minLength 1 and required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: { scanId: { type?: string; minLength?: number } };
      required?: string[];
    };
    expect(json.properties.scanId.type).toBe("string");
    expect(json.properties.scanId.minLength).toBe(1);
    expect(json.required).toContain("scanId");
  });
});

describe("depsight_list_policies argument schema (no arguments)", () => {
  const schema = inputShape(registerPolicyTools, "depsight_list_policies");

  it("accepts an empty argument object", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.parse({})).toEqual({});
  });

  it("accepts and strips an unrecognised extra property instead of rejecting", () => {
    const result = schema.safeParse({ repoId: "r" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it("publishes no properties and nothing required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(json.properties ?? {}).toEqual({});
    expect(json.required ?? []).toEqual([]);
  });
});

describe("depsight_list_repos argument schema (no arguments)", () => {
  const schema = inputShape(registerRepoTools, "depsight_list_repos");

  it("accepts an empty argument object", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.parse({})).toEqual({});
  });

  it("accepts and strips an unrecognised extra property instead of rejecting", () => {
    const result = schema.safeParse({ repoId: "r" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it("publishes no properties and nothing required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(json.properties ?? {}).toEqual({});
    expect(json.required ?? []).toEqual([]);
  });
});

describe("depsight_get_overview argument schema (no arguments)", () => {
  const schema = inputShape(registerRepoTools, "depsight_get_overview");

  it("accepts an empty argument object", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.parse({})).toEqual({});
  });

  it("accepts and strips an unrecognised extra property instead of rejecting", () => {
    const result = schema.safeParse({ repoId: "r" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it("publishes no properties and nothing required", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(json.properties ?? {}).toEqual({});
    expect(json.required ?? []).toEqual([]);
  });
});

describe("depsight_get_cves argument schema (publishedAfter has no datetime validation)", () => {
  const schema = inputShape(registerCveTools, "depsight_get_cves");

  it.each([
    ["2026-10-01", "a plain date"],
    ["2026-10-01T12:00:00.000Z", "a full timestamp"],
    ["not-a-date", "a string no Date accepts"],
    ["", "the empty string"],
  ])("accepts %s (%s) and passes it through unchanged", (value) => {
    expect(schema.parse({ repoId: "r", publishedAfter: value }).publishedAfter).toBe(
      value,
    );
  });

  it("omits publishedAfter entirely (optional; no cutoff applied)", () => {
    const parsed = schema.parse({ repoId: "r" });
    expect(parsed.publishedAfter).toBeUndefined();
    expect("publishedAfter" in parsed).toBe(false);
  });

  it("rejects a non-string publishedAfter", () => {
    expect(() => schema.parse({ repoId: "r", publishedAfter: 0 })).toThrow();
  });

  it("publishes publishedAfter as an optional string with no format", () => {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties: { publishedAfter: { type?: string; format?: string } };
      required?: string[];
    };
    expect(json.properties.publishedAfter.type).toBe("string");
    expect(json.properties.publishedAfter.format).toBeUndefined();
    expect(json.required ?? []).not.toContain("publishedAfter");
  });
});

describe("every registered tool has argument tests here (coverage guard)", () => {
  // The expected names are not hand-copied: createServer registers exactly
  // TOOL_REGISTRARS, so calling every registrar against a recording fake
  // server yields the tool list the product would publish in tools/list.
  function registeredToolNames(): string[] {
    const registered: string[] = [];
    const recordingServer = {
      tool: (name: string) => {
        registered.push(name);
      },
    } as unknown as McpServer;
    for (const register of TOOL_REGISTRARS) {
      register(recordingServer, {} as DepsightClient);
    }
    return registered;
  }

  it("registers a non-empty set of distinct tool names through TOOL_REGISTRARS", () => {
    const registered = registeredToolNames();
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("pins the argument schema of every registered tool (no untested tool)", () => {
    expect([...coveredToolNames].sort()).toEqual(
      [...registeredToolNames()].sort(),
    );
  });
});
