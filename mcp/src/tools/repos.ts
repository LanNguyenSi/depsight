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
 * `id` only and gets no `repoId` field. A malformed entry in the list's own
 * `repos` array (not an object, or `null`) is returned unchanged rather than
 * throwing or being spread into character keys.
 *
 * `fullName` is a case-sensitive exact match and is not a stable key: it is
 * only refreshed by depsight's own sync, so a rename-and-recreate on GitHub
 * can leave it stale until the next sync. If two overview entries collide on
 * the same `fullName`, that name is ambiguous and no `repoId` is attached to
 * the matching list entry at all, never a last-write-wins guess.
 *
 * When the `overview` argument itself is not a recognisable overview
 * (undefined, because `/api/overview` failed, timed out, or came back in an
 * unrecognised shape), the repoId merge could not run at all: no entry gets
 * a `repoId`, indistinguishable from "not tracked yet" unless callers can
 * tell the two cases apart. The returned list then carries a top-level
 * `repoIdMergeUnavailable: true` marker so a caller can tell "not tracked"
 * from "the merge didn't run this call" and confirm with
 * `depsight_get_overview`. When the overview is usable the key is omitted
 * entirely (never emitted as `false`).
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

  const overviewUsable =
    typeof overview === "object" &&
    overview !== null &&
    Array.isArray((overview as OverviewLike).repos);

  const repoIdByFullName = new Map<string, string>();
  const ambiguousFullNames = new Set<string>();
  if (overviewUsable) {
    for (const entry of (overview as { repos: unknown[] }).repos) {
      if (typeof entry !== "object" || entry === null) continue;
      const { repoId, fullName } = entry as RepoHealthSummaryLike;
      if (typeof repoId === "string" && typeof fullName === "string") {
        if (repoIdByFullName.has(fullName)) {
          ambiguousFullNames.add(fullName);
          continue;
        }
        repoIdByFullName.set(fullName, repoId);
      }
    }
  }
  for (const fullName of ambiguousFullNames) {
    repoIdByFullName.delete(fullName);
  }

  const repos = (
    (listResponse as { repos: unknown[] }).repos as Array<unknown>
  ).map((repo) => {
    if (typeof repo !== "object" || repo === null) return repo;
    const repoRecord = repo as Record<string, unknown>;
    const fullName =
      typeof repoRecord.fullName === "string" ? repoRecord.fullName : undefined;
    const repoId = fullName !== undefined ? repoIdByFullName.get(fullName) : undefined;
    return repoId !== undefined ? { ...repoRecord, repoId } : { ...repoRecord };
  });

  const merged: Record<string, unknown> = {
    ...(listResponse as Record<string, unknown>),
    repos,
  };
  if (!overviewUsable) {
    merged.repoIdMergeUnavailable = true;
  }
  return merged;
}

/** How long depsight_list_repos waits on /api/overview before giving up on
 *  the repoId merge and returning the plain GitHub list. */
const OVERVIEW_TIMEOUT_MS = 5000;

/**
 * Fetch /api/overview with a bounded wait: a slow or hanging overview
 * degrades to `undefined` (no repoId added) through the same catch path
 * already used for an outright overview fetch failure, instead of
 * stalling depsight_list_repos indefinitely. Exported so the timeout
 * behavior itself is unit-testable with a small `timeoutMs` rather than
 * the production value.
 */
export function fetchOverviewWithTimeout(
  client: DepsightClient,
  timeoutMs: number,
): Promise<unknown> {
  return client.getOverview(AbortSignal.timeout(timeoutMs)).catch(() => undefined);
}

export function registerRepoTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_list_repos",
    "List the GitHub repositories the authenticated user has access to (via their GitHub token). This is the live GitHub list, not depsight's tracked-repo set. Archived repos are excluded, matching depsight's own tracked repos, which are untracked (and excluded from scan/policy evaluation) once GitHub reports them as archived. Each entry's `id` is GitHub's numeric repo id, kept unchanged; entries depsight tracks (added by the dashboard's Sync action or the sync cron; no scan required) also carry `repoId`, depsight's own id. Pass that value, not `id`, to depsight_rescan / depsight_get_cves / depsight_get_deps / etc. `repoId` is matched by full name at the time of depsight's last sync, so after a rename-and-recreate on GitHub the value can be stale until the next sync. An entry with no `repoId` is EITHER not yet tracked (can only be added through depsight's own sync, not through depsight_rescan, which requires an existing `repoId`) OR its overview leg was unavailable for this call: the `/api/overview` fetch failed, exceeded its 5s bound, or came back in an unrecognised shape, flagged by a top-level `repoIdMergeUnavailable: true` on the response. A `fullName` ambiguous across two tracked repos also yields no `repoId`, but is NOT flagged that way. In both cases, confirm with depsight_get_overview before treating an entry as untracked.",
    {},
    async () => {
      try {
        const [data, overview] = await Promise.all([
          client.listRepos(),
          fetchOverviewWithTimeout(client, OVERVIEW_TIMEOUT_MS),
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
