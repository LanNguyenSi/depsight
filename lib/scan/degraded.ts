// Degraded-source tracking for the three scanners.
//
// A source (GitHub, OSV) that answers "nothing here" (404, an empty repository)
// is a normal empty result. A source that could not be read at all (401, 403,
// 5xx, a network error, a timeout) must not look the same: the scanner still
// completes with whatever it found, but its run is recorded as degraded so the
// per-scanner failure marker shows and its last-success time does not advance.
//
// Sources report through `noteDegraded`, a no-op outside a tracking scope, so
// readers that never call a noting source are unaffected (PR scanning via
// fetchRepoAdvisories, SBOM, the export bundle reader); the export route's
// on-demand scans are tracked like any other scan. A scanner opens a scope
// with `trackDegraded` around its source reads. The scope
// is an AsyncLocalStorage store so the leaf readers (manifest discovery, the
// per-ecosystem manifest readers) need no signature change, and the three
// scanners the cron runs in parallel each see only their own reads.
//
// Server-only: uses node:async_hooks, so client components import the pure
// helpers from ./freshness instead.
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_REASONS = 5;

interface Tracker {
  reasons: string[];
  omitted: number;
  /** Memoized whole-repository check: at most one probe per tracking scope. */
  repoCheck?: Promise<void>;
}

const storage = new AsyncLocalStorage<Tracker>();

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * True when the source answered "there is nothing at this path": a missing
 * file or manifest or license (404), or the git tree of a repository that has
 * no commit yet (409, "Git Repository is empty"). Anything else (401, 403,
 * 5xx, network, timeout, rate limit) means the source could not be read.
 */
export function isNothingThere(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 404) return true;
  if (status === 409) return /empty/i.test((err as { message?: unknown }).message?.toString() ?? '');
  return false;
}

function describeDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  const status = statusOf(detail);
  const message = detail instanceof Error ? detail.message : String(detail);
  return status !== undefined ? `HTTP ${status}: ${message}` : message;
}

/** Record that `source` could not be read. No-op outside a `trackDegraded` scope. */
export function noteDegraded(source: string, detail: unknown): void {
  const tracker = storage.getStore();
  if (!tracker) return;
  const reason = `${source}: ${describeDetail(detail)}`;
  if (tracker.reasons.includes(reason)) return;
  if (tracker.reasons.length >= MAX_REASONS) {
    tracker.omitted += 1;
    return;
  }
  tracker.reasons.push(reason);
}

/**
 * A 404 on the git tree or the root listing is ambiguous: the repository may
 * exist and simply have nothing there, or it may be gone (or invisible to the
 * token) so that every read answers 404. `probe` reads the repository itself
 * (`repos.get`); when that also answers 404 the whole repository is unreadable
 * and is noted as degraded ("repository not readable"). A probe failure other
 * than 404 is noted like any unreadable source. The probe runs at most once per
 * tracking scope, however many 404 paths ask, and not at all outside a scope.
 */
export async function confirmRepositoryReadable(probe: () => Promise<unknown>): Promise<void> {
  const tracker = storage.getStore();
  if (!tracker) return;
  tracker.repoCheck ??= (async () => {
    try {
      await probe();
    } catch (err) {
      if (statusOf(err) === 404) noteDegraded('repository not readable', err);
      else if (!isNothingThere(err)) noteDegraded('GitHub repository check', err);
    }
  })();
  await tracker.repoCheck;
}

/**
 * Run `fn` and report every source it could not read. `degraded` is null when
 * every source was read (an empty result counts as read) and otherwise one
 * line naming the unreadable sources.
 */
export async function trackDegraded<T>(fn: () => Promise<T>): Promise<{ value: T; degraded: string | null }> {
  const tracker: Tracker = { reasons: [], omitted: 0 };
  const value = await storage.run(tracker, fn);
  if (tracker.reasons.length === 0) return { value, degraded: null };
  const more = tracker.omitted > 0 ? `; +${tracker.omitted} more` : '';
  return { value, degraded: `${tracker.reasons.join('; ')}${more}` };
}
