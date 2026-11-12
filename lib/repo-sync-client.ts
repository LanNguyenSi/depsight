/**
 * Client-side call of `POST /api/repos/sync`, shared by the overview and the
 * dashboard. Returns the failure text instead of throwing, so the caller
 * reloads only on success and otherwise shows the message.
 */

export const SYNC_FAILED_MESSAGE = 'Sync failed';
export const SYNC_NETWORK_ERROR_MESSAGE = 'Network error';

export type RepoSyncResult = { ok: true } | { ok: false; error: string };

export async function requestRepoSync(
  fetchFn: typeof fetch = fetch,
): Promise<RepoSyncResult> {
  try {
    const res = await fetchFn('/api/repos/sync', { method: 'POST' });
    if (res.ok) return { ok: true };
    const body: unknown = await res.json().catch(() => null);
    const error =
      body !== null && typeof body === 'object'
        ? (body as { error?: unknown }).error
        : undefined;
    return {
      ok: false,
      error: typeof error === 'string' && error !== '' ? error : SYNC_FAILED_MESSAGE,
    };
  } catch {
    return { ok: false, error: SYNC_NETWORK_ERROR_MESSAGE };
  }
}
