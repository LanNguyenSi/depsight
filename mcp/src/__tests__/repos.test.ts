import { describe, it, expect } from "vitest";
import { registerRepoTools, withDepsightRepoIds } from "../tools/repos.js";
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
// `repoId`, matched here by `fullName` (reproduced against the live server
// 2026-09-10: depsight_list_repos returned GitHub numeric ids only, and
// depsight_rescan with one of those ids 404'd "Repository not found").
const GITHUB_LIST = {
  repos: [
    { id: 1193429543, fullName: "LanNguyenSi/depsight", name: "depsight" },
    { id: 999999999, fullName: "LanNguyenSi/untracked-repo", name: "untracked-repo" },
  ],
};

const OVERVIEW = {
  repos: [
    { repoId: "cmn9yluwe0002pe01eu6uhpu2", fullName: "LanNguyenSi/depsight" },
  ],
  aggregate: { totalRepos: 1 },
};

describe("withDepsightRepoIds", () => {
  it("adds repoId to entries matched by fullName, leaves unmatched entries without it", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, OVERVIEW) as {
      repos: Array<Record<string, unknown>>;
    };

    expect(merged.repos[0]).toEqual({
      id: 1193429543,
      fullName: "LanNguyenSi/depsight",
      name: "depsight",
      repoId: "cmn9yluwe0002pe01eu6uhpu2",
    });
    expect(merged.repos[1]).toEqual({
      id: 999999999,
      fullName: "LanNguyenSi/untracked-repo",
      name: "untracked-repo",
    });
    expect("repoId" in merged.repos[1]).toBe(false);
  });

  it("keeps GitHub's id unchanged (never renamed or overwritten)", () => {
    const merged = withDepsightRepoIds(GITHUB_LIST, OVERVIEW) as {
      repos: Array<Record<string, unknown>>;
    };
    expect(merged.repos[0].id).toBe(1193429543);
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
        { fullName: "LanNguyenSi/depsight" }, // repoId missing
        { repoId: "some-id" }, // fullName missing
        { repoId: 42, fullName: "LanNguyenSi/depsight" }, // repoId wrong type
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
          id: 1193429543,
          fullName: "LanNguyenSi/depsight",
          name: "depsight",
          repoId: "cmn9yluwe0002pe01eu6uhpu2",
        },
        { id: 999999999, fullName: "LanNguyenSi/untracked-repo", name: "untracked-repo" },
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
    const depsightEntry = list.repos.find((r) => r.fullName === "LanNguyenSi/depsight");
    expect(depsightEntry?.repoId).toBe("cmn9yluwe0002pe01eu6uhpu2");
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
