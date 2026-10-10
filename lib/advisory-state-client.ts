// Browser-side helpers for the per-finding triage state (acknowledged /
// ignored). Pure over fetch so they can be tested without a DOM.

export type AdvisoryStatusValue = 'ACKNOWLEDGED' | 'IGNORED';

export interface AdvisoryStateInfo {
  status: AdvisoryStatusValue;
  note: string | null;
  setBy: string | null;
  setAt: string;
}

export interface AdvisoryIdentity {
  ghsaId: string;
  packageName: string;
}

/** The identity a triage state is stored under: advisory id plus package. */
export function advisoryStateKey(a: AdvisoryIdentity): string {
  return `${a.ghsaId} ${a.packageName}`;
}

/**
 * Set (status given) or clear (status null) the state of one finding.
 * Resolves to the new state, or null after a clear. Throws when the server
 * refuses, so the caller can keep the previous state on screen.
 */
export async function saveAdvisoryState(
  repoId: string,
  advisory: AdvisoryIdentity,
  status: AdvisoryStatusValue | null,
  fetchImpl: typeof fetch = fetch,
): Promise<AdvisoryStateInfo | null> {
  const identity = { repoId, ghsaId: advisory.ghsaId, packageName: advisory.packageName };
  const res = await fetchImpl('/api/advisory-state', {
    method: status === null ? 'DELETE' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(status === null ? identity : { ...identity, status }),
  });
  if (!res.ok) {
    throw new Error(`advisory state request failed with ${res.status}`);
  }
  if (status === null) return null;
  const data = (await res.json()) as { state: AdvisoryStateInfo };
  return data.state;
}
