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
});
