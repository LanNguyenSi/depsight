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
    init?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
    },
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
      signal: init?.signal,
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
    if (res.status === 429) {
      throw new RateLimitError(
        path,
        parsed,
        parseRetryAfterSeconds(parsed, res.headers.get("Retry-After")),
      );
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

  getOverview(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/api/overview", { signal });
  }

  /**
   * Each tracked repo's own `repoId` paired with GitHub's numeric
   * `githubId`, with no team-health computation. Cheap alternative to
   * `getOverview` for callers that only need the id pair, such as
   * `depsight_list_repos`'s repoId merge.
   */
  getTrackedRepoIds(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/api/repos/tracked-ids", { signal });
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

  listPolicies(): Promise<unknown> {
    return this.request("GET", "/api/policies");
  }

  evaluatePolicy(scanId: string): Promise<unknown> {
    return this.request("POST", "/api/policies/evaluate", { body: { scanId } });
  }

  getSbom(repoId: string): Promise<unknown> {
    return this.request("GET", "/api/sbom", { query: { repoId } });
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

  // ── Write tools ──────────────────────────────────────────────

  /**
   * Trigger a CVE scan for a single repository.
   * The scan runs synchronously; the response includes the resulting scanId
   * which can be passed to depsight_get_cves / depsight_evaluate_policy.
   */
  rescan(repoId: string): Promise<unknown> {
    return this.request("POST", "/api/scan", { body: { repoId } });
  }
}

/** Used when a 429 carries neither a usable body value nor a Retry-After header. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * HTTP 429 from one of depsight's per-user rate limits. Names the wait in
 * `retryAfterSeconds` (body value, else the Retry-After header, else a default)
 * so an agent can back off instead of treating it as a generic failure.
 */
export class RateLimitError extends HttpError {
  constructor(
    path: string,
    body: unknown,
    public readonly retryAfterSeconds: number,
  ) {
    super(429, path, body);
    this.name = "RateLimitError";
    this.message = `Depsight ${path} → rate limit exceeded (HTTP 429), retryAfterSeconds: ${retryAfterSeconds}. Wait that long before retrying.`;
  }
}

function positiveSeconds(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.ceil(value);
}

export function parseRetryAfterSeconds(
  body: unknown,
  retryAfterHeader: string | null,
): number {
  const fromBody =
    body !== null && typeof body === "object"
      ? positiveSeconds((body as { retryAfterSeconds?: unknown }).retryAfterSeconds)
      : null;
  if (fromBody !== null) return fromBody;
  const fromHeader =
    retryAfterHeader === null ? null : positiveSeconds(retryAfterHeader);
  return fromHeader ?? DEFAULT_RETRY_AFTER_SECONDS;
}
