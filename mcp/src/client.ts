import type { Config } from "./config.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Depsight ${path} → HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

/**
 * Thin HTTP client around depsight's Next.js API. Every request
 * carries `Authorization: Bearer <dsat_...>` — the token is minted
 * per user and scopes every tool call to that user's repos.
 */
export class DepsightClient {
  constructor(private readonly config: Config) {}

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const url = new URL(this.config.gatewayUrl + path);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.config.apiToken}`,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new HttpError(res.status, path, parsed);
    }
    return parsed as T;
  }

  // ── Read tools (v1) ─────────────────────────────────────────

  listRepos(): Promise<unknown> {
    return this.request("GET", "/api/repos");
  }

  getOverview(): Promise<unknown> {
    return this.request("GET", "/api/overview");
  }

  getScan(repoId: string): Promise<unknown> {
    return this.request("GET", "/api/scan", { query: { repoId } });
  }

  getDeps(repoId: string): Promise<unknown> {
    return this.request("GET", "/api/deps", { query: { repoId } });
  }

  getLicense(repoId: string): Promise<unknown> {
    return this.request("GET", "/api/license", { query: { repoId } });
  }

  getHistory(repoId: string, limit?: number): Promise<unknown> {
    return this.request("GET", "/api/history", { query: { repoId, limit } });
  }

  evaluatePolicy(scanId: string): Promise<unknown> {
    return this.request("POST", "/api/policies/evaluate", { body: { scanId } });
  }

  getCiAnalytics(
    repoId: string,
    type: "fail-rate" | "build-times" | "flaky" | "bottleneck",
    period: 1 | 7 | 30,
  ): Promise<unknown> {
    return this.request("GET", `/api/ci/analytics/${encodeURIComponent(repoId)}`, {
      query: { type, period },
    });
  }

  getCiAnalyticsCrossRepo(period: 1 | 7 | 30): Promise<unknown> {
    return this.request("GET", "/api/ci/analytics/cross-repo", {
      query: { period },
    });
  }
}
