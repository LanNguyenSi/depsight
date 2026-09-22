import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DepsightClient } from "../client.js";
import { errResult, ok } from "./shared.js";

interface TrackedRepoIdEntryLike {
  repoId?: unknown;
  githubId?: unknown;
}

interface TrackedIdsResponseLike {
  repos?: unknown;
}

interface ListReposResponseLike {
  repos?: unknown;
}

/**
 * Merge depsight's own `repoId` (the id `depsight_rescan` /
 * `depsight_get_cves` expect) into each GitHub repo entry returned by
 * `/api/repos`, matched by GitHub's numeric repo id (`githubId`) against
 * `GET /api/repos/tracked-ids`, a cheap endpoint that returns only each
 * tracked repo's own `repoId` and `githubId` with no team-health
 * computation (no call into `getTeamHealthOverview`). Matching is
 * best-effort: a repo GitHub reports but depsight has not tracked/scanned
 * yet (so it has no tracked-ids entry) keeps its GitHub `id` only and gets
 * no `repoId` field. A malformed entry in the list's own `repos` array (not
 * an object, or `null`) is returned unchanged rather than throwing or being
 * spread into character keys.
 *
 * The join key is `githubId`, GitHub's own numeric repo id and depsight's
 * `Repo` model's unique-per-user column -- never `fullName`, which two
 * tracked repos can legitimately share (a rename-and-recreate, or two repos
 * with the same name under different owners whose `fullName` collided in
 * the old overview-based merge) and which is only refreshed by depsight's
 * own sync. Because the match never looks at `fullName` at all, two tracked
 * repos sharing one `fullName` each resolve to their own, distinct `repoId`
 * instead of neither getting one.
 *
 * When the `trackedIds` argument itself is not a recognisable tracked-ids
 * response (undefined, because the endpoint failed, timed out, or came back
 * in an unrecognised shape), the repoId merge could not run at all: no
 * entry gets a `repoId`, indistinguishable from "not tracked yet" unless
 * callers can tell the two cases apart. The returned list then carries a
 * top-level `repoIdMergeUnavailable: true` marker so a caller can tell "not
 * tracked" from "the merge didn't run this call" and confirm with
 * `depsight_get_overview`. When the tracked-ids response is usable the key
 * is omitted entirely (never emitted as `false`).
 */
export function withDepsightRepoIds(
  listResponse: unknown,
  trackedIds: unknown,
): unknown {
  if (
    typeof listResponse !== "object" ||
    listResponse === null ||
    !Array.isArray((listResponse as ListReposResponseLike).repos)
  ) {
    return listResponse;
  }

  const trackedIdsUsable =
    typeof trackedIds === "object" &&
    trackedIds !== null &&
    Array.isArray((trackedIds as TrackedIdsResponseLike).repos);

  const repoIdByGithubId = new Map<number, string>();
  if (trackedIdsUsable) {
    for (const entry of (trackedIds as { repos: unknown[] }).repos) {
      if (typeof entry !== "object" || entry === null) continue;
      const { repoId, githubId } = entry as TrackedRepoIdEntryLike;
      if (typeof repoId === "string" && typeof githubId === "number") {
        repoIdByGithubId.set(githubId, repoId);
      }
    }
  }

  const repos = (
    (listResponse as { repos: unknown[] }).repos as Array<unknown>
  ).map((repo) => {
    if (typeof repo !== "object" || repo === null) return repo;
    const repoRecord = repo as Record<string, unknown>;
    const githubId =
      typeof repoRecord.id === "number" ? repoRecord.id : undefined;
    const repoId = githubId !== undefined ? repoIdByGithubId.get(githubId) : undefined;
    return repoId !== undefined ? { ...repoRecord, repoId } : { ...repoRecord };
  });

  const merged: Record<string, unknown> = {
    ...(listResponse as Record<string, unknown>),
    repos,
  };
  if (!trackedIdsUsable) {
    merged.repoIdMergeUnavailable = true;
  }
  return merged;
}

/** How long depsight_list_repos waits on GET /api/repos/tracked-ids before
 *  giving up on the repoId merge and returning the plain GitHub list. */
const TRACKED_IDS_TIMEOUT_MS = 5000;

/**
 * Fetch GET /api/repos/tracked-ids with a bounded wait: a slow or hanging
 * response degrades to `undefined` (no repoId added) through the same catch
 * path already used for an outright fetch failure, instead of stalling
 * depsight_list_repos indefinitely. Exported so the timeout behavior itself
 * is unit-testable with a small `timeoutMs` rather than the production
 * value.
 */
export function fetchTrackedIdsWithTimeout(
  client: DepsightClient,
  timeoutMs: number,
): Promise<unknown> {
  return client.getTrackedRepoIds(AbortSignal.timeout(timeoutMs)).catch(() => undefined);
}

export function registerRepoTools(
  server: McpServer,
  client: DepsightClient,
): void {
  server.tool(
    "depsight_list_repos",
    "List the GitHub repositories the authenticated user has access to (via their GitHub token). This is the live GitHub list, not depsight's tracked-repo set. Archived repos are excluded, matching depsight's own tracked repos, which are untracked (and excluded from scan/policy evaluation) once GitHub reports them as archived. Each entry's `id` is GitHub's numeric repo id, kept unchanged; entries depsight tracks (added by the dashboard's Sync action or the sync cron; no scan required) also carry `repoId`, depsight's own id. Pass that value, not `id`, to depsight_rescan / depsight_get_cves / depsight_get_deps / etc. `repoId` is matched by GitHub's numeric repo id (never by name), so a rename or a fullName shared by two tracked repos does not affect it. An entry with no `repoId` is EITHER not yet tracked (can only be added through depsight's own sync, not through depsight_rescan, which requires an existing `repoId`) OR the tracked-ids lookup was unavailable for this call: the `GET /api/repos/tracked-ids` fetch failed, exceeded its 5s bound, or came back in an unrecognised shape, flagged by a top-level `repoIdMergeUnavailable: true` on the response. In that case, confirm with depsight_get_overview before treating an entry as untracked. A repo that was deleted and recreated on GitHub gets a new numeric id from GitHub, so its entry carries no `repoId` until depsight's next sync links the new id, and this case is not flagged by `repoIdMergeUnavailable`.",
    {},
    async () => {
      try {
        const [data, trackedIds] = await Promise.all([
          client.listRepos(),
          fetchTrackedIdsWithTimeout(client, TRACKED_IDS_TIMEOUT_MS),
        ]);
        return ok(withDepsightRepoIds(data, trackedIds));
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
