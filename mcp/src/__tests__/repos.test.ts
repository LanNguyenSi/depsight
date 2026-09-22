import { describe, it, expect } from "vitest";
import {
  registerRepoTools,
  withDepsightRepoIds,
  fetchTrackedIdsWithTimeout,
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
// `{ repos: [...] }` and uses GitHub's numeric `id`; /api/repos/tracked-ids
// wraps its tracked-repo id pairs the same way and keys them by GitHub's
// numeric `githubId` -- the join key -- alongside depsight's own `repoId`.
// Values are neutral placeholders, not real repos; provenance for the
// original bug this fixture pins is in CHANGELOG.md.
const GITHUB_LIST = {
  repos: [
    { id: 10001001, fullName: "acme/widgets", name: "widgets" },
    { id: 20002002, fullName: "acme/untracked-repo", name: "untracked-repo" },
  ],
};

const TRACKED_IDS = {
  repos: [{ repoId: "repo-cuid-1", githubId: 10001001 }],
};

describe("withDepsightRepoIds", () => {
  it("adds repoId to entries matched by githubId, leaves unmatched entries without it", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, TRACKED_IDS) as {
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
    const merged = withDepsightRepoIds(GITHUB_LIST, TRACKED_IDS) as {
      repos: Array<Record<string, unknown>>;
    };
    expect(merged.repos[0].id).toBe(10001001);
  });

  it("marks repoIdMergeUnavailable when trackedIds has an unrecognized shape (repos unchanged, no repoId)", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, { unexpected: true });
    expect(merged).toEqual({ ...GITHUB_LIST, repoIdMergeUnavailable: true });
  });

  it("marks repoIdMergeUnavailable when trackedIds is undefined", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, undefined);
    expect(merged).toEqual({ ...GITHUB_LIST, repoIdMergeUnavailable: true });
  });

  it("omits repoIdMergeUnavailable entirely (never `false`) when trackedIds is usable", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, TRACKED_IDS) as Record<string, unknown>;
    expect("repoIdMergeUnavailable" in merged).toBe(false);
  });

  it("treats an empty trackedIds repos array as a usable answer (nothing tracked, no repoId anywhere, no unavailable marker)", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, { repos: [] }) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(merged.repos[0]).toEqual(GITHUB_LIST.repos[0]);
    expect(merged.repos[1]).toEqual(GITHUB_LIST.repos[1]);
    expect("repoIdMergeUnavailable" in merged).toBe(false);
  });

  it("returns the input unchanged when the list itself has an unrecognized shape", () => {
    const weird = { notRepos: [] };
    expect(withDepsightRepoIds(weird, TRACKED_IDS)).toBe(weird);
  });

  it("skips malformed tracked-ids entries (non-object, or missing/wrong-typed repoId/githubId) without throwing", () => {
    const messyTrackedIds = {
      repos: [
        null,
        "not-an-object",
        { fullName: "acme/widgets" }, // neither repoId nor githubId
        { repoId: "some-id" }, // githubId missing
        { githubId: 10001001 }, // repoId missing
        { repoId: 42, githubId: 10001001 }, // repoId wrong type
        { repoId: "some-id", githubId: "10001001" }, // githubId wrong type (string, not number)
      ],
    };

    const merged = withDepsightRepoIds(GITHUB_LIST, messyTrackedIds) as {
      repos: Array<Record<string, unknown>>;
    };

    expect("repoId" in merged.repos[0]).toBe(false);
  });

  it("leaves a repo entry whose id is not a number untouched (no lookup key to match on)", () => {
    const listWithoutNumericId = { repos: [{ fullName: "acme/widgets", name: "no-id" }] };

    const merged = withDepsightRepoIds(listWithoutNumericId, TRACKED_IDS) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(merged.repos[0]).toEqual({ fullName: "acme/widgets", name: "no-id" });
  });

  it("resolves two tracked repos that share one fullName to their own distinct repoId (join is on githubId, never fullName)", () => {
    // The old fullName-keyed merge treated a shared fullName as ambiguous
    // and attached no repoId to either entry. The githubId join has no such
    // collision: GitHub's numeric id is unique per repo, so both entries
    // resolve correctly even though their fullName is identical.
    const listSharedFullName = {
      repos: [
        { id: 10001001, fullName: "acme/widgets", name: "widgets-old" },
        { id: 30003003, fullName: "acme/widgets", name: "widgets-new" },
      ],
    };
    const trackedIdsSharedFullName = {
      repos: [
        { repoId: "repo-cuid-1", githubId: 10001001 },
        { repoId: "repo-cuid-3", githubId: 30003003 },
      ],
    };

    const merged = withDepsightRepoIds(listSharedFullName, trackedIdsSharedFullName) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(merged.repos[0].repoId).toBe("repo-cuid-1");
    expect(merged.repos[1].repoId).toBe("repo-cuid-3");
    expect(merged.repos[0].fullName).toBe(merged.repos[1].fullName);
  });

  it("returns a null or primitive entry in the list's own repos array unchanged, without throwing or reshaping it", () => {
    const messyList = {
      repos: [null, "oops", { id: 10001001, fullName: "acme/widgets" }],
    };

    const merged = withDepsightRepoIds(messyList, TRACKED_IDS) as {
      repos: Array<unknown>;
    };

    expect(merged.repos[0]).toBeNull();
    expect(merged.repos[1]).toBe("oops");
    expect(merged.repos[2]).toEqual({
      id: 10001001,
      fullName: "acme/widgets",
      repoId: "repo-cuid-1",
    });
  });

  it("preserves a top-level key beside `repos` on the list response", () => {
    const listWithSiblingKey = { repos: GITHUB_LIST.repos, cursor: "next-page-token" };

    const merged = withDepsightRepoIds(listWithSiblingKey, TRACKED_IDS) as {
      repos: Array<Record<string, unknown>>;
      cursor: string;
    };

    expect(merged.cursor).toBe("next-page-token");
  });
});

describe("depsight_list_repos tool", () => {
  it("returns the list shape: repoId present only where tracked-ids matched, GitHub id untouched", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => GITHUB_LIST,
      getTrackedRepoIds: async () => TRACKED_IDS,
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

  it("still returns the list when the tracked-ids fetch fails (repoId omitted, repoIdMergeUnavailable set, not an error)", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => GITHUB_LIST,
      getTrackedRepoIds: async () => {
        throw new Error("tracked-ids unavailable");
      },
    });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual({
      ...GITHUB_LIST,
      repoIdMergeUnavailable: true,
    });
  });

  it("converts a client throw into an isError result", async () => {
    const handlers = captureRepoHandlers({
      listRepos: async () => {
        throw new Error("gateway down");
      },
      getTrackedRepoIds: async () => TRACKED_IDS,
    });

    const result = await handlers["depsight_list_repos"]({});

    expect(result.isError).toBe(true);
    expect(parseToolText(result)).toEqual({
      success: false,
      error: "gateway down",
    });
  });
});

describe("fetchTrackedIdsWithTimeout", () => {
  it(
    "resolves to undefined within its own timeout when the tracked-ids call never settles",
    async () => {
      // Mirrors what a real `fetch` does on AbortSignal.timeout: the
      // request never resolves on its own, only rejects once the signal
      // fires. If the timeout wrap is dropped, this promise (and the
      // test) hangs until vitest's own per-test timeout below kills it,
      // so a missing timeout fails loudly instead of hanging the suite.
      const client: Partial<DepsightClient> = {
        getTrackedRepoIds: (signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };

      const result = await fetchTrackedIdsWithTimeout(client as DepsightClient, 50);

      expect(result).toBeUndefined();

      // Feeding that `undefined` into the merge (what depsight_list_repos
      // does) must surface as repoIdMergeUnavailable, not a silent "not
      // tracked" result.
      const merged = withDepsightRepoIds(GITHUB_LIST, result) as Record<
        string,
        unknown
      >;
      expect(merged.repoIdMergeUnavailable).toBe(true);
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
      getTrackedRepoIds: async () => TRACKED_IDS,
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
