import { describe, it, expect, beforeEach, vi } from "vitest";
import { DepsightClient, HttpError } from "../client.js";

function makeResponse(body: unknown, init?: { status?: number }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DepsightClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the Bearer token and Accept header on every request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ repos: [] }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.listRepos();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://depsight.example.com/api/repos");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
    expect(headers.Accept).toBe("application/json");
    expect(init?.method).toBe("GET");
  });

  it("encodes query params correctly and skips undefined values", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => makeResponse({ history: [] }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getHistory("repo-1", 50);
    await client.getHistory("repo-1"); // limit omitted

    const url1 = String(fetchSpy.mock.calls[0][0]);
    const url2 = String(fetchSpy.mock.calls[1][0]);
    expect(url1).toContain("repoId=repo-1");
    expect(url1).toContain("limit=50");
    expect(url2).toContain("repoId=repo-1");
    expect(url2).not.toContain("limit");
  });

  it("sends POST body JSON for evaluatePolicy", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ violations: [], count: 0 }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.evaluatePolicy("scan-abc");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://depsight.example.com/api/policies/evaluate",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ scanId: "scan-abc" }));
  });

  it("URL-encodes repoId in path segments for CI analytics", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ type: "fail-rate", data: {} }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getCiAnalytics("repo/with slashes", "fail-rate", 7);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/api/ci/analytics/repo%2Fwith%20slashes");
    expect(url).toContain("type=fail-rate");
    expect(url).toContain("period=7");
  });

  it("throws an HttpError carrying status and parsed body on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "Unauthorized" }, { status: 401 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_bad",
    });

    await expect(client.listRepos()).rejects.toBeInstanceOf(HttpError);
    try {
      await client.listRepos();
      throw new Error("expected the previous call to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(401);
      expect(e.path).toBe("/api/repos");
      expect(e.body).toEqual({ error: "Unauthorized" });
    }
  });

  it("falls back to raw text when the response body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse("gateway timeout", { status: 504 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.listRepos()).rejects.toSatisfy((err: unknown) => {
      const e = err as HttpError;
      return e.status === 504 && e.body === "gateway timeout";
    });
  });

  it("listPolicies hits GET /api/policies with no query params", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ policies: [] }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.listPolicies();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://depsight.example.com/api/policies");
    expect(init?.method).toBe("GET");
  });

  it("getSbom hits GET /api/sbom?repoId=...", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ bomFormat: "CycloneDX" }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getSbom("repo-xyz");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://depsight.example.com/api/sbom?repoId=repo-xyz",
    );
    expect(init?.method).toBe("GET");
  });

  it("getSbom resolves to a parsed object, not a string (guards against double-encoding)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ bomFormat: "CycloneDX", components: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    const result = await client.getSbom("repo-xyz");
    expect(typeof result).toBe("object");
    expect((result as { bomFormat: string }).bomFormat).toBe("CycloneDX");
  });

  it("getSbom throws HttpError on 404 (exercises the errResult path)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "no_scan" }, { status: 404 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.getSbom("repo-missing")).rejects.toBeInstanceOf(
      HttpError,
    );
    try {
      await client.getSbom("repo-missing");
      throw new Error("expected getSbom to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(404);
      expect(e.path).toBe("/api/sbom");
      expect((e.body as { error: string }).error).toBe("no_scan");
    }
  });

  it("getOverview hits GET /api/overview with Bearer auth and no query params", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ repos: 3, criticalCves: 1 }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    const result = await client.getOverview();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://depsight.example.com/api/overview");
    expect(init?.method).toBe("GET");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
    expect(result).toEqual({ repos: 3, criticalCves: 1 });
  });

  it("getOverview throws HttpError carrying status and parsed body on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "Internal Server Error" }, { status: 500 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.getOverview()).rejects.toBeInstanceOf(HttpError);
    try {
      await client.getOverview();
      throw new Error("expected getOverview to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(500);
      expect(e.path).toBe("/api/overview");
      expect((e.body as { error: string }).error).toBe("Internal Server Error");
    }
  });

  it("getScan hits GET /api/scan?repoId=... with Bearer auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ scanId: "scan-1", status: "completed" }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getScan("repo-abc");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://depsight.example.com/api/scan?repoId=repo-abc",
    );
    expect(init?.method).toBe("GET");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
  });

  it("getScan throws HttpError carrying status and parsed body on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "no_scan" }, { status: 404 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.getScan("repo-missing")).rejects.toBeInstanceOf(
      HttpError,
    );
    try {
      await client.getScan("repo-missing");
      throw new Error("expected getScan to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(404);
      expect(e.path).toBe("/api/scan");
      expect((e.body as { error: string }).error).toBe("no_scan");
    }
  });

  it("getDeps hits GET /api/deps?repoId=... with Bearer auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ deps: [] }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getDeps("repo-xyz");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://depsight.example.com/api/deps?repoId=repo-xyz",
    );
    expect(init?.method).toBe("GET");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
  });

  it("getDeps throws HttpError carrying status and parsed body on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "Unauthorized" }, { status: 401 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_bad",
    });

    await expect(client.getDeps("repo-abc")).rejects.toBeInstanceOf(
      HttpError,
    );
    try {
      await client.getDeps("repo-abc");
      throw new Error("expected getDeps to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(401);
      expect(e.path).toBe("/api/deps");
      expect((e.body as { error: string }).error).toBe("Unauthorized");
    }
  });

  it("getLicense hits GET /api/license?repoId=... with Bearer auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ licenses: [] }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getLicense("repo-lic");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://depsight.example.com/api/license?repoId=repo-lic",
    );
    expect(init?.method).toBe("GET");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
  });

  it("getLicense throws HttpError carrying status and parsed body on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "no_scan" }, { status: 404 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.getLicense("repo-missing")).rejects.toBeInstanceOf(
      HttpError,
    );
    try {
      await client.getLicense("repo-missing");
      throw new Error("expected getLicense to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(404);
      expect(e.path).toBe("/api/license");
      expect((e.body as { error: string }).error).toBe("no_scan");
    }
  });

  it("getCiAnalyticsCrossRepo hits GET /api/ci/analytics/cross-repo?period=... with Bearer auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResponse({ repos: [] }));

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await client.getCiAnalyticsCrossRepo(7);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://depsight.example.com/api/ci/analytics/cross-repo?period=7",
    );
    expect(init?.method).toBe("GET");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dsat_test");
  });

  it("getCiAnalyticsCrossRepo throws HttpError carrying status and parsed body on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      makeResponse({ error: "Internal Server Error" }, { status: 500 }),
    );

    const client = new DepsightClient({
      gatewayUrl: "https://depsight.example.com",
      apiToken: "dsat_test",
    });

    await expect(client.getCiAnalyticsCrossRepo(1)).rejects.toBeInstanceOf(
      HttpError,
    );
    try {
      await client.getCiAnalyticsCrossRepo(1);
      throw new Error("expected getCiAnalyticsCrossRepo to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.status).toBe(500);
      expect(e.path).toBe("/api/ci/analytics/cross-repo");
      expect((e.body as { error: string }).error).toBe("Internal Server Error");
    }
  });
});
