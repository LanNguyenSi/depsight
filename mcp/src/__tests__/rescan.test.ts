import { describe, it, expect, beforeEach, vi } from "vitest";
import { DepsightClient, HttpError } from "../client.js";
import { registerRescanTools } from "../tools/rescan.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: { repoId: string }) => Promise<ToolResult>;

/** Capture the handler registerRescanTools registers, so the tool wrapper
 *  (envelope mapping, defaulting, error path) can be exercised without a real
 *  McpServer. */
function captureRescanHandler(rescan: (repoId: string) => Promise<unknown>): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handler = cb;
    },
  } as unknown as McpServer;
  const fakeClient = { rescan } as unknown as DepsightClient;
  registerRescanTools(fakeServer, fakeClient);
  if (!handler) throw new Error("registerRescanTools did not register a handler");
  return handler;
}

function parseToolText(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeResponse(body: unknown, init?: { status?: number }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
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

describe("depsight_rescan tool wrapper", () => {
  it("maps the client response into the success envelope", async () => {
    const handler = captureRescanHandler(async () => ({
      scanId: "scan-123",
      status: "completed",
      dependabotDisabled: true,
    }));

    const result = await handler({ repoId: "repo-abc" });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual({
      success: true,
      repoId: "repo-abc",
      scanId: "scan-123",
      status: "completed",
      dependabotDisabled: true,
      message: expect.stringContaining("depsight_get_cves"),
    });
  });

  it("defaults status/dependabotDisabled when the backend omits them", async () => {
    const handler = captureRescanHandler(async () => ({ scanId: "scan-9" }));

    const body = parseToolText(await handler({ repoId: "repo-9" }));

    expect(body.status).toBe("completed");
    expect(body.dependabotDisabled).toBe(false);
    expect(body.scanId).toBe("scan-9");
  });

  it("converts a thrown HttpError into an isError result", async () => {
    const handler = captureRescanHandler(async () => {
      throw new HttpError(403, "/api/scan", { error: "Repository not found or access denied" });
    });

    const result = await handler({ repoId: "repo-denied" });

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toMatchObject({ success: false });
  });
});
