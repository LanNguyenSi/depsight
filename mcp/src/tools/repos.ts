import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

interface RepoHealthSummaryLike {
  repoId?: unknown;
  fullName?: unknown;
}

interface OverviewLike {
  repos?: unknown;
}

interface ListReposResponseLike {
  repos?: unknown;
}

/**
 * Merge depsight's own `repoId` (the id `depsight_rescan` /
 * `depsight_get_cves` expect) into each GitHub repo entry returned by
 * `/api/repos`, matched by `fullName` against `/api/overview`'s per-repo
 * health summaries (the only place depsight's Next.js API exposes that id
 * today). Matching is best-effort: a repo GitHub reports but depsight has
 * not tracked/scanned yet (so it has no overview entry) keeps its GitHub
 * `id` only and gets no `repoId` field. Unrecognized shapes are returned
 * unchanged rather than throwing, so a shape drift in either endpoint
 * degrades to "no repoId added" instead of failing the whole list.
 */
export function withDepsightRepoIds(
  listResponse: unknown,
  overview: unknown,
): unknown {
  if (
    typeof listResponse !== "object" ||
    listResponse === null ||
    !Array.isArray((listResponse as ListReposResponseLike).repos)
  ) {
    return listResponse;
  }

  const repoIdByFullName = new Map<string, string>();
  if (
    typeof overview === "object" &&
    overview !== null &&
    Array.isArray((overview as OverviewLike).repos)
  ) {
    for (const entry of (overview as { repos: unknown[] }).repos) {
      if (typeof entry !== "object" || entry === null) continue;
      const { repoId, fullName } = entry as RepoHealthSummaryLike;
      if (typeof repoId === "string" && typeof fullName === "string") {
        repoIdByFullName.set(fullName, repoId);
      }
    }
  }

  const repos = (
    (listResponse as { repos: unknown[] }).repos as Array<Record<string, unknown>>
  ).map((repo) => {
    const fullName = typeof repo.fullName === "string" ? repo.fullName : undefined;
    const repoId = fullName !== undefined ? repoIdByFullName.get(fullName) : undefined;
    return repoId !== undefined ? { ...repo, repoId } : { ...repo };
  });

  return { ...(listResponse as Record<string, unknown>), repos };
}

export function registerRepoTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_list_repos",
    "List the GitHub repositories the authenticated user has access to (via their GitHub token). This is the live GitHub list, not depsight's tracked-repo set. Archived repos are excluded, matching depsight's own tracked repos, which are untracked (and excluded from scan/policy evaluation) once GitHub reports them as archived. Each entry's `id` is GitHub's numeric repo id, kept unchanged; entries depsight has tracked (has scanned at least once, via depsight_rescan or the depsight app's own sync) also carry `repoId`, depsight's own id. Pass that value, not `id`, to depsight_rescan / depsight_get_cves / depsight_get_deps / etc. An entry with no `repoId` has not been tracked by depsight yet.",
    {},
    async () => {
      try {
        const [data, overview] = await Promise.all([
          client.listRepos(),
          client.getOverview().catch(() => undefined),
        ]);
        return ok(withDepsightRepoIds(data, overview));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  server.tool(
    "depsight_get_overview",
    "Team-health dashboard summary across all tracked repos: aggregate CVE counts, risk scores, license issues, and the top riskiest repos. No arguments.",
    {},
    async () => {
      try {
        const data = await client.getOverview();
        return ok(data);
      } catch (e) {
        return errResult(e);
      }
    },
  );
}
