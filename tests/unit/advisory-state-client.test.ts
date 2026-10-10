import { describe, it, expect, vi } from 'vitest';
import { advisoryStateKey, saveAdvisoryState } from '@/lib/advisory-state-client';

const advisory = { ghsaId: 'GHSA-1', packageName: 'lodash' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('advisoryStateKey', () => {
  it('is the advisory id plus the package, so one advisory in two packages has two keys', () => {
    expect(advisoryStateKey(advisory)).toBe('GHSA-1 lodash');
    expect(advisoryStateKey({ ghsaId: 'GHSA-1', packageName: 'lodash-es' })).not.toBe(
      advisoryStateKey(advisory),
    );
  });
});

describe('saveAdvisoryState', () => {
  it('PUTs the identity and status and returns the stored state', async () => {
    const state = { status: 'IGNORED', note: null, setBy: 'octocat', setAt: '2026-02-01T00:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { state }));
    const result = await saveAdvisoryState('repo-1', advisory, 'IGNORED', fetchMock as unknown as typeof fetch);
    expect(result).toEqual(state);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/advisory-state');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      repoId: 'repo-1',
      ghsaId: 'GHSA-1',
      packageName: 'lodash',
      status: 'IGNORED',
    });
  });

  it('DELETEs the identity without a status to clear and returns null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, cleared: true }));
    const result = await saveAdvisoryState('repo-1', advisory, null, fetchMock as unknown as typeof fetch);
    expect(result).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({
      repoId: 'repo-1',
      ghsaId: 'GHSA-1',
      packageName: 'lodash',
    });
  });

  it('throws when the server refuses, so the caller keeps the previous state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'Repository not found' }));
    await expect(
      saveAdvisoryState('repo-1', advisory, 'ACKNOWLEDGED', fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/404/);
  });
});
