import { describe, it, expect, beforeEach, vi } from "vitest";
import { DepsightClient, HttpError, RateLimitError } from "../client.js";
import { registerRescanTools } from "../tools/rescan.js";
import { registerDepsTools } from "../tools/deps.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type RescanTarget = "cves" | "deps" | "all";
type ToolHandler = (args: {
  repoId: string;
  target?: RescanTarget;
}) => Promise<ToolResult>;

interface RescanMocks {
  rescan: (repoId: string) => Promise<unknown>;
  rescanDeps: (repoId: string) => Promise<unknown>;
  calls: string[];
}

/** Capture the handler registerRescanTools registers, so the tool wrapper
 *  (envelope mapping, target dispatch, defaulting, error path) can be
 *  exercised without a real McpServer. `calls` records the order in which the
 *  two client methods are invoked. */
function captureRescanHandler(
  mocks: {
    rescan?: (repoId: string) => Promise<unknown>;
    rescanDeps?: (repoId: string) => Promise<unknown>;
  } = {},
): RescanMocks & { handler: ToolHandler } {
  const calls: string[] = [];
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const rescan =
    mocks.rescan ??
    (async () => ({ scanId: "cve-scan-1", status: "completed", dependabotDisabled: false }));
  const rescanDeps =
    mocks.rescanDeps ??
    (async () => ({
      scanId: "deps-scan-1",
      summary: { total: 2, upToDate: 1, outdated: 1, majorBehind: 0, deprecated: 0, unknown: 0 },
    }));
  const client = {
    rescan: async (repoId: string) => {
      calls.push("rescan");
      return rescan(repoId);
    },
    rescanDeps: async (repoId: string) => {
      calls.push("rescanDeps");
      return rescanDeps(repoId);
    },
  } as unknown as DepsightClient;
  registerRescanTools(fakeServer, client);
  if (!handler) throw new Error("registerRescanTools did not register a handler");
  return { handler, calls, rescan, rescanDeps };
}

function parseToolText(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("DepsightClient.rescan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/scan with Bearer token and repoId in body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        makeResponse({ scanId: "scan-123", status: "completed", dependabotDisabled: false }),
      );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    const result = await client.rescan("repo-abc");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://depsight.example.com/api/scan");
    expect(init?.method).toBe("POST");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(init?.body).toBe(JSON.stringify({ repoId: "repo-abc" }));
    expect(result).toEqual({ scanId: "scan-123", status: "completed", dependabotDisabled: false });
  });

  it("returns scanId and status from the response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ scanId: "scan-xyz", status: "completed", dependabotDisabled: true }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    const result = (await client.rescan("repo-999")) as {
      scanId: string;
      status: string;
      dependabotDisabled: boolean;
    };

    expect(result.scanId).toBe("scan-xyz");
    expect(result.status).toBe("completed");
    expect(result.dependabotDisabled).toBe(true);
  });

  it("throws HttpError with status 401 on unauthorized request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "Unauthorized" }, { status: 401 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_bad",
    });

    await expect(client.rescan("repo-abc")).rejects.toBeInstanceOf(HttpError);

    try {
      await client.rescan("repo-abc");
      throw new Error("expected rescan to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(401);
      expect(e.path).toBe("/api/scan");
      expect((e.body as { error: string }).error).toBe("Unauthorized");
    }
  });

  it("throws HttpError with status 400 when backend rejects missing repoId", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "repoId is required" }, { status: 400 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.rescan("")).rejects.toBeInstanceOf(HttpError);

    try {
      await client.rescan("");
      throw new Error("expected rescan to reject");
    } catch (err) {
      const e = err as HttpError;
      expect(e.status).toBe(400);
      expect((e.body as { error: string }).error).toBe("repoId is required");
    }
  });

  it("throws HttpError with status 500 on scan failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ error: "Scan failed" }, { status: 500 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.rescan("repo-broken")).rejects.toSatisfy((err: unknown) => {
      const e = err as HttpError;
      return e.status === 500 && (e.body as { error: string }).error === "Scan failed";
    });
  });
});

describe("DepsightClient.rescanDeps", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/deps with Bearer token and repoId in body, returning scanId and summary", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({
        scanId: "deps-scan-9",
        summary: { total: 3, upToDate: 2, outdated: 1, majorBehind: 0, deprecated: 0, unknown: 0 },
      }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_write",
    });

    const result = await client.rescanDeps("repo-abc");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://depsight.example.com/api/deps");
    expect(init?.method).toBe("POST");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_write");

    expect(init?.body).toBe(JSON.stringify({ repoId: "repo-abc" }));
    expect(result).toMatchObject({ scanId: "deps-scan-9" });
  });

  it("surfaces a 403 with a message naming the missing write scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ error: "This token does not have write access" }, { status: 403 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_read",
    });

    try {
      await client.rescanDeps("repo-abc");
      throw new Error("expected rescanDeps to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(403);
      expect(e.path).toBe("/api/deps");
      expect(e.message).toContain("WRITE-scoped token");
    }
  });

  it("throws RateLimitError with retryAfterSeconds on a 429 (shared rate-limit path)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": "90" } },
      ),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_write",
    });

    await expect(client.rescanDeps("repo-abc")).rejects.toBeInstanceOf(RateLimitError);

    try {
      await client.rescanDeps("repo-abc");
      throw new Error("expected rescanDeps to reject");
    } catch (err) {
      const e = err as RateLimitError;
      expect(e.retryAfterSeconds).toBe(90);
      expect(e.message).toContain("retryAfterSeconds: 90");
    }
  });
});

describe("depsight_rescan tool wrapper", () => {
  it("maps the client response into the success envelope", async () => {
    const { handler } = captureRescanHandler({
      rescan: async () => ({ scanId: "scan-123", status: "completed", dependabotDisabled: true }),
    });

    const result = await handler({ repoId: "repo-abc" });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual({
      success: true,
      repoId: "repo-abc",
      scanId: "scan-123",
      status: "completed",
      dependabotDisabled: true,
      degradedReason: null,
      message: expect.stringContaining("depsight_get_cves"),
    });
  });

  it("says a scan is already in progress (not 'Scan completed') when the backend reports status running", async () => {
    const { handler } = captureRescanHandler({
      rescan: async () => ({ scanId: "scan-123", status: "running", dependabotDisabled: false }),
    });

    const result = await handler({ repoId: "repo-abc" });

    expect(result.isError).toBeUndefined();
    const body = parseToolText(result);
    expect(body.status).toBe("running");
    expect(body.message).toEqual(expect.stringContaining("already in progress"));
    expect(body.message).not.toEqual(expect.stringContaining("Scan completed"));
  });

  it("still says 'Scan completed' when the backend reports status completed", async () => {
    const { handler } = captureRescanHandler({
      rescan: async () => ({ scanId: "scan-456", status: "completed", dependabotDisabled: false }),
    });

    const result = await handler({ repoId: "repo-def" });

    const body = parseToolText(result);
    expect(body.status).toBe("completed");
    expect(body.message).toEqual(expect.stringContaining("Scan completed"));
  });

  it("defaults status/dependabotDisabled when the backend omits them", async () => {
    const { handler } = captureRescanHandler({ rescan: async () => ({ scanId: "scan-9" }) });

    const body = parseToolText(await handler({ repoId: "repo-9" }));

    expect(body.status).toBe("completed");
    expect(body.dependabotDisabled).toBe(false);
    expect(body.scanId).toBe("scan-9");
  });

  it("converts a thrown HttpError into an isError result", async () => {
    const { handler } = captureRescanHandler({
      rescan: async () => {
        throw new HttpError(403, "/api/scan", { error: "Repository not found or access denied" });
      },
    });

    const result = await handler({ repoId: "repo-denied" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toMatchObject({ success: false });
  });

  describe("tool handler degradedReason", () => {
    it("passes the degraded reason through and says the result is degraded", async () => {
      const { handler } = captureRescanHandler({
        rescan: async () => ({
          scanId: "scan-1",
          status: "completed",
          dependabotDisabled: false,
          degradedReason: "OSV: HTTP 500: down",
        }),
      });
      const out = parseToolText(await handler({ repoId: "repo-1" }));
      expect(out.degradedReason).toBe("OSV: HTTP 500: down");
      expect(out.status).toBe("completed");
      expect(String(out.message)).toContain("degraded");
    });

    it("reports degradedReason null and the unchanged message for a healthy or older backend answer", async () => {
      for (const answer of [
        { scanId: "scan-1", status: "completed", dependabotDisabled: false, degradedReason: null },
        { scanId: "scan-1", status: "completed", dependabotDisabled: false },
      ]) {
        const { handler } = captureRescanHandler({ rescan: async () => answer });
        const out = parseToolText(await handler({ repoId: "repo-1" }));
        expect(out.degradedReason).toBeNull();
        expect(out.message).toBe(
          "Scan completed. Call depsight_get_cves with this repoId to read updated CVE results.",
        );
      }
    });
  });
});

describe("depsight_rescan target dispatch", () => {
  it("absent target runs the CVE scan only (deps endpoint not called, shape unchanged)", async () => {
    const { handler, calls } = captureRescanHandler();

    const result = await handler({ repoId: "repo-abc" });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["rescan"]);
    const body = parseToolText(result);
    expect("target" in body).toBe(false);
    expect("depsScanId" in body).toBe(false);
  });

  it('target "cves" runs the CVE scan only', async () => {
    const { handler, calls } = captureRescanHandler();

    const result = await handler({ repoId: "repo-abc", target: "cves" });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["rescan"]);
    const body = parseToolText(result);
    expect(body.scanId).toBe("cve-scan-1");
    expect(String(body.message)).toContain("depsight_get_cves");
  });

  it('target "deps" runs only the dependency-age scan and names depsight_get_deps', async () => {
    const { handler, calls } = captureRescanHandler();

    const result = await handler({ repoId: "repo-abc", target: "deps" });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["rescanDeps"]);
    const body = parseToolText(result);
    expect(body).toEqual({
      success: true,
      repoId: "repo-abc",
      target: "deps",
      depsScanId: "deps-scan-1",
      depsSummary: { total: 2, upToDate: 1, outdated: 1, majorBehind: 0, deprecated: 0, unknown: 0 },
      message: expect.stringContaining("depsight_get_deps"),
    });
  });

  it('target "all" runs the CVE scan first, then the dependency-age scan, and reports both', async () => {
    const { handler, calls } = captureRescanHandler();

    const result = await handler({ repoId: "repo-abc", target: "all" });

    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["rescan", "rescanDeps"]);
    const body = parseToolText(result);
    expect(body.target).toBe("all");
    expect(body.scanId).toBe("cve-scan-1");
    expect(body.depsScanId).toBe("deps-scan-1");
    expect(body.depsSummary).toMatchObject({ total: 2 });
    expect(String(body.message)).toContain("depsight_get_cves");
    expect(String(body.message)).toContain("depsight_get_deps");
  });

  it('target "deps" defaults depsSummary to null when the backend omits it', async () => {
    const { handler } = captureRescanHandler({ rescanDeps: async () => ({ scanId: "d-1" }) });

    const body = parseToolText(await handler({ repoId: "repo-abc", target: "deps" }));

    expect(body.depsScanId).toBe("d-1");
    expect(body.depsSummary).toBeNull();
  });

  it('target "all" defaults depsSummary to null when the backend omits it', async () => {
    const { handler } = captureRescanHandler({ rescanDeps: async () => ({ scanId: "d-1" }) });

    const body = parseToolText(await handler({ repoId: "repo-abc", target: "all" }));

    expect(body.depsScanId).toBe("d-1");
    expect(body.depsSummary).toBeNull();
  });

  it('target "all" surfaces a CVE scan failure through the unchanged CVE error path and never starts the deps scan', async () => {
    const { handler, calls } = captureRescanHandler({
      rescan: async () => {
        throw new HttpError(500, "/api/scan", { error: "Scan failed" });
      },
    });

    const result = await handler({ repoId: "repo-abc", target: "all" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual(["rescan"]);
    expect(parseToolText(result)).toMatchObject({ success: false });
  });

  it('target "deps" surfaces the write-scope 403 as an isError result', async () => {
    const { handler } = captureRescanHandler({
      rescanDeps: async () => {
        throw new HttpError(403, "/api/deps", { error: "This token does not have write access" });
      },
    });

    const result = await handler({ repoId: "repo-abc", target: "deps" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toMatchObject({ success: false });
  });
});

describe("depsight_rescan target all, partial failure", () => {
  function failingDeps(error: Error): () => Promise<unknown> {
    return async () => {
      throw error;
    };
  }

  it("reports which part failed on a deps 403: CVE success stays visible, deps refresh is not claimed", async () => {
    const { handler, calls } = captureRescanHandler({
      rescanDeps: failingDeps(
        new HttpError(403, "/api/deps", { error: "This token does not have write access" }),
      ),
    });

    const result = await handler({ repoId: "repo-abc", target: "all" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual(["rescan", "rescanDeps"]);
    const body = parseToolText(result);
    expect(body.success).toBe(false);
    expect(body.target).toBe("all");
    expect(body.scanId).toBe("cve-scan-1");
    expect(body.status).toBe("completed");
    expect(body.depsScanId).toBeUndefined();
    const error = String(body.error);
    expect(error).toContain("CVE scan completed");
    expect(error).toContain("dependency-age scan failed");
    expect(error).toContain("was not refreshed");
    expect(error).not.toContain("Dependency-age scan completed");
  });

  it("keeps the rate-limit fields on a deps 429", async () => {
    const { handler } = captureRescanHandler({
      rescanDeps: failingDeps(
        new RateLimitError("/api/deps", { error: "Rate limit exceeded", retryAfterSeconds: 120 }, 120),
      ),
    });

    const result = await handler({ repoId: "repo-abc", target: "all" });

    expect(result.isError).toBe(true);
    const body = parseToolText(result);
    expect(body.success).toBe(false);
    expect(body.scanId).toBe("cve-scan-1");
    expect(body.retryAfterSeconds).toBe(120);
    expect(String(body.error)).toContain("retryAfterSeconds: 120");
  });

  it("stringifies a non-Error deps failure cause", async () => {
    const { handler } = captureRescanHandler({
      rescanDeps: failingDeps("boom" as unknown as Error),
    });

    const result = await handler({ repoId: "repo-abc", target: "all" });

    expect(result.isError).toBe(true);
    const body = parseToolText(result);
    expect(body.scanId).toBe("cve-scan-1");
    expect(String(body.error)).toContain("Cause: boom");
  });

  it("reports the failure cause on a deps 500 without hiding the CVE result", async () => {
    const { handler } = captureRescanHandler({
      rescanDeps: failingDeps(new HttpError(500, "/api/deps", { error: "Dependency analysis failed" })),
    });

    const result = await handler({ repoId: "repo-abc", target: "all" });

    expect(result.isError).toBe(true);
    const body = parseToolText(result);
    expect(body.scanId).toBe("cve-scan-1");
    expect(String(body.error)).toContain("Dependency analysis failed");
  });
});

describe("depsight_rescan on a rate limit", () => {
  it("returns an error envelope that names retryAfterSeconds", async () => {
    const { handler } = captureRescanHandler({
      rescan: async () => {
        throw new RateLimitError("/api/scan", { error: "Rate limit exceeded", retryAfterSeconds: 321 }, 321);
      },
    });

    const result = await handler({ repoId: "repo-abc" });

    expect(result.isError).toBe(true);
    const parsed = parseToolText(result);
    expect(parsed.success).toBe(false);
    expect(parsed.retryAfterSeconds).toBe(321);
    expect(parsed.error).toContain("retryAfterSeconds: 321");
  });
});

describe("depsight_rescan target deps contract with depsight_get_deps", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("after a deps rescan, depsight_get_deps reads back the fresh scan (new scannedAt)", async () => {
    const handlers: Record<string, ToolHandler> = {};
    const fakeServer = {
      tool: (name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
        handlers[name] = cb;
      },
    } as unknown as McpServer;
    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_write",
    });
    registerRescanTools(fakeServer, client);
    registerDepsTools(fakeServer, client);

    let depsScanRefreshed = false;

    // Route by method: POST /api/deps refreshes, GET /api/deps then serves the new scan.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const href = String(input);
      if (href === "https://depsight.example.com/api/deps" && init?.method === "POST") {
        expect(init.body).toBe(JSON.stringify({ repoId: "repo-abc" }));
        depsScanRefreshed = true;
        return makeResponse({
          scanId: "scan-fresh",
          summary: { total: 1, upToDate: 1, outdated: 0, majorBehind: 0, deprecated: 0, unknown: 0 },
        });
      }
      if (href === "https://depsight.example.com/api/deps?repoId=repo-abc") {
        return makeResponse(
          depsScanRefreshed
            ? { scanId: "scan-fresh", scannedAt: "2026-10-31T09:00:00.000Z", summary: { total: 1 }, dependencies: [] }
            : { scanId: "scan-old", scannedAt: "2026-10-01T09:00:00.000Z", summary: { total: 1 }, dependencies: [] },
        );
      }
      throw new Error(`unexpected url ${href}`);
    });

    const before = parseToolText(await handlers.depsight_get_deps({ repoId: "repo-abc" }));
    expect(before.scannedAt).toBe("2026-10-01T09:00:00.000Z");

    const rescanOut = await handlers.depsight_rescan({ repoId: "repo-abc", target: "deps" });
    expect(rescanOut.isError).toBeUndefined();
    expect(parseToolText(rescanOut).depsScanId).toBe("scan-fresh");

    const after = parseToolText(await handlers.depsight_get_deps({ repoId: "repo-abc" }));
    expect(after.scannedAt).toBe("2026-10-31T09:00:00.000Z");
    expect(after.scanId).toBe("scan-fresh");
  });
});
