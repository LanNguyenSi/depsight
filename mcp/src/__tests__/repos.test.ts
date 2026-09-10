import { describe, it, expect } from "vitest";
import {
  registerRepoTools,
  withDepsightRepoIds,
  fetchOverviewWithTimeout,
} from "../tools/repos.js";
import { registerRescanTools } from "../tools/rescan.js";
import { registerCveTools } from "../tools/cves.js";
import type { DepsightClient } from "../client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../tools/shared.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** registerRepoTools registers TWO tools (depsight_list_repos,
 *  depsight_get_overview): capture both by name, mirroring the
 *  rescan.test.ts fakeServer pattern. */
function captureHandlers(
  register: (server: McpServer, client: DepsightClient) => void,
  client: Partial<DepsightClient>,
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, cb: ToolHandler) => {
      handlers[name] = cb;
    },
  } as unknown as McpServer;
  register(fakeServer, client as DepsightClient);
  return handlers;
}

function captureRepoHandlers(client: Partial<DepsightClient>): Record<string, ToolHandler> {
  return captureHandlers(registerRepoTools, client);
}

function parseToolText(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// Fixture shaped like the real depsight API: /api/repos wraps entries in
// `{ repos: [...] }` and uses GitHub's numeric `id`; /api/overview wraps its
// per-repo health summaries the same way and keys them by depsight's own
// `repoId`, matched here by `fullName`. Values are neutral placeholders, not
// real repos; provenance for the bug this fixture pins is in CHANGELOG.md.
const GITHUB_LIST = {
  repos: [
    { id: 10001001, fullName: "acme/widgets", name: "widgets" },
    { id: 20002002, fullName: "acme/untracked-repo", name: "untracked-repo" },
  ],
};

const OVERVIEW = {
  repos: [
    { repoId: "repo-cuid-1", fullName: "acme/widgets" },
  ],
  aggregate: { totalRepos: 1 },
};

describe("withDepsightRepoIds", () => {
  it("adds repoId to entries matched by fullName, leaves unmatched entries without it", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, OVERVIEW) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(merged.repos[0]).toEqual({
      id: 10001001,
      fullName: "acme/widgets",
      name: "widgets",
      repoId: "repo-cuid-1",
    });
    expect(merged.repos[1]).toEqual({
      id: 20002002,
      fullName: "acme/untracked-repo",
      name: "untracked-repo",
    });
    expect("repoId" in merged.repos[1]).toBe(false);
  });

  it("keeps GitHub's id unchanged (never renamed or overwritten)", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, OVERVIEW) as {
      repos: Array<Record<string, unknown>>;
    };
    expect(merged.repos[0].id).toBe(10001001);
  });

  it("returns the list unchanged when overview has an unrecognized shape", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, { unexpected: true });
    expect(merged).toEqual(GITHUB_LIST);
  });

  it("returns the input unchanged when the list itself has an unrecognized shape", () => {
    const weird = { notRepos: [] };
    expect(withDepsightRepoIds(weird, OVERVIEW)).toBe(weird);
  });

  it("skips malformed overview entries (non-object, or missing repoId/fullName) without throwing", () => {
    const messyOverview = {
      repos: [
        null,
        "not-an-object",
        { fullName: "acme/widgets" }, // repoId missing
        { repoId: "some-id" }, // fullName missing
        { repoId: 42, fullName: "acme/widgets" }, // repoId wrong type
      ],
    };

    const merged = withDepsightRepoIds(GITHUB_LIST, messyOverview) as {
      repos: Array<Record<string, unknown>>;
    };

    expect("repoId" in merged.repos[0]).toBe(false);
  });

  it("leaves a repo entry without a fullName untouched (no lookup key to match on)", () => {
    const listWithoutFullName = { repos: [{ id: 1, name: "no-fullname" }] };

    const merged = withDepsightRepoIds(listWithoutFullName, OVERVIEW) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(merged.repos[0]).toEqual({ id: 1, name: "no-fullname" });
  });

  it("attaches no repoId when two overview entries share a fullName (never last-write-wins)", () => {
    const ambiguousOverview = {
      repos: [
        { repoId: "repo-cuid-1", fullName: "acme/widgets" },
        { repoId: "repo-cuid-2", fullName: "acme/widgets" },
      ],
    };

    const merged = withDepsightRepoIds(GITHUB_LIST, ambiguousOverview) as {
      repos: Array<Record<string, unknown>>;
    };

    expect("repoId" in merged.repos[0]).toBe(false);
    expect(merged.repos[0]).toEqual({
      id: 10001001,
      fullName: "acme/widgets",
      name: "widgets",
    });
  });

  it("does not match a case-differing fullName", () => {
    const caseDifferentOverview = {
      repos: [{ repoId: "repo-cuid-1", fullName: "Acme/Widgets" }],
    };

    const merged = withDepsightRepoIds(GITHUB_LIST, caseDifferentOverview) as {
      repos: Array<Record<string, unknown>>;
    };

    expect("repoId" in merged.repos[0]).toBe(false);
  });

  it("preserves a top-level key beside `repos` on the list response", () => {
    const listWithSiblingKey = { repos: GITHUB_LIST.repos, cursor: "next-page-token" };

    const merged = withDepsightRepoIds(listWithSiblingKey, OVERVIEW) as {
      repos: Array<Record<string, unknown>>;
      cursor: string;
    };

    expect(merged.cursor).toBe("next-page-token");
  });
});

describe("depsight_list_repos tool", () => {
  it("returns the list shape: repoId present only where overview matched, GitHub id untouched", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => GITHUB_LIST,
      getOverview: async () => OVERVIEW,
    });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual({
      repos: [
        {
          id: 10001001,
          fullName: "acme/widgets",
          name: "widgets",
          repoId: "repo-cuid-1",
        },
        { id: 20002002, fullName: "acme/untracked-repo", name: "untracked-repo" },
      ],
    });
  });

  it("still returns the list when the overview fetch fails (repoId omitted, not an error)", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => GITHUB_LIST,
      getOverview: async () => {
        throw new Error("overview unavailable");
      },
    });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(GITHUB_LIST);
  });

  it("converts a client throw into an isError result", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => {
        throw new Error("gateway down");
      },
      getOverview: async () => OVERVIEW,
    });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "gateway down",
    });
  });
});

describe("fetchOverviewWithTimeout", () => {
  it(
    "resolves to undefined within its own timeout when the overview call never settles",
    async () => {
      // Mirrors what a real `fetch` does on AbortSignal.timeout: the
      // request never resolves on its own, only rejects once the signal
      // fires. If the timeout wrap is dropped, this promise (and the
      // test) hangs until vitest's own per-test timeout below kills it,
      // so a missing timeout fails loudly instead of hanging the suite.
      const client: Partial<DepsightClient> = {
        getOverview: (signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };

      const result = await fetchOverviewWithTimeout(client as DepsightClient, 50);

      expect(result).toBeUndefined();
    },
    1000,
  );
});

describe("depsight_get_overview tool", () => {
  it("returns the client's overview payload unwrapped", async () => {
    const overview = { totalRepos: 3, totalCves: 12, riskiestRepos: [] };
    const handlers = captureRepoHandlers({ getOverview: async () => overview });

    const result = await handlers["depsight_get_overview"]({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(overview);
  });

  it("converts a client throw into an isError result", async () => {
    const handlers = captureRepoHandlers({
      getOverview: async () => {
        throw new Error("unauthorized");
      },
    });

    const result = await handlers["depsight_get_overview"]({});

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "unauthorized",
    });
  });
});

describe("round trip: depsight_list_repos -> depsight_rescan -> depsight_get_cves", () => {
  it("uses the repoId the list returned, not GitHub's id, and both downstream calls receive it", async () => {
    const rescanCalls: string[] = [];
    const getScanCalls: string[] = [];

    const client: Partial<DepsightClient> = {
      listRepos: async () => GITHUB_LIST,
      getOverview: async () => OVERVIEW,
      rescan: async (repoId: string) => {
        rescanCalls.push(repoId);
        return { scanId: "scan-1", status: "completed" };
      },
      getScan: async (repoId: string) => {
        getScanCalls.push(repoId);
        return { scan: { advisories: [] } };
      },
    };

    const repoHandlers = captureRepoHandlers(client);
    const rescanHandlers = captureHandlers(registerRescanTools, client);
    const cveHandlers = captureHandlers(registerCveTools, client);

    const listResult = await repoHandlers["depsight_list_repos"]({});
    const list = parseToolText(listResult) as {
      repos: Array<{ id: number; repoId?: string; fullName: string }>;
    };
    const depsightEntry = list.repos.find((r) => r.fullName === "acme/widgets");
    expect(depsightEntry?.repoId).toBe("repo-cuid-1");
    const repoId = depsightEntry!.repoId!;

    // Using the GitHub id instead would be the exact bug this task fixes;
    // assert the two are distinct so the round trip below can't pass by
    // accident.
    expect(repoId).not.toBe(String(depsightEntry!.id));

    const rescanResult = await rescanHandlers["depsight_rescan"]({ repoId });
    expect(rescanResult.isError).toBeUndefined();
    expect(rescanCalls).toEqual([repoId]);

    const cvesResult = await cveHandlers["depsight_get_cves"]({ repoId });
    expect(cvesResult.isError).toBeUndefined();
    expect(getScanCalls).toEqual([repoId]);
  });
});
