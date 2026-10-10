import { describe, it, expect, vi } from 'vitest';
import {
  advisoryStateKey,
  isHiddenAsIgnored,
  resolveAdvisoryState,
  saveAdvisoryState,
} from '@/lib/advisory-state-client';

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

describe('resolveAdvisoryState', () => {
  const ignored = { status: 'IGNORED' as const, note: null, setBy: 'octocat', setAt: '2026-02-01T00:00:00.000Z' };
  const acknowledged = { ...ignored, status: 'ACKNOWLEDGED' as const };

  it('uses the state the scan response carried when nothing was changed in this session', () => {
    expect(resolveAdvisoryState({ ...advisory, state: ignored }, {})).toEqual(ignored);
    expect(resolveAdvisoryState({ ...advisory }, {})).toBeNull();
    expect(resolveAdvisoryState({ ...advisory, state: null }, {})).toBeNull();
  });

  it('lets a server-accepted override win over the carried state', () => {
    const key = advisoryStateKey(advisory);
    expect(resolveAdvisoryState({ ...advisory, state: ignored }, { [key]: acknowledged })).toEqual(acknowledged);
  });

  it('treats a null override as "reopened", not as "no override"', () => {
    const key = advisoryStateKey(advisory);
    expect(resolveAdvisoryState({ ...advisory, state: ignored }, { [key]: null })).toBeNull();
  });

  it('ignores an override stored for another package of the same advisory', () => {
    const other = advisoryStateKey({ ghsaId: 'GHSA-1', packageName: 'lodash-es' });
    expect(resolveAdvisoryState({ ...advisory, state: ignored }, { [other]: null })).toEqual(ignored);
  });
});

describe('isHiddenAsIgnored', () => {
  const base = { note: null, setBy: null, setAt: '2026-02-01T00:00:00.000Z' };

  it('hides only ignored findings, and only while the toggle is on', () => {
    expect(isHiddenAsIgnored({ ...base, status: 'IGNORED' }, true)).toBe(true);
    expect(isHiddenAsIgnored({ ...base, status: 'IGNORED' }, false)).toBe(false);
    expect(isHiddenAsIgnored({ ...base, status: 'ACKNOWLEDGED' }, true)).toBe(false);
    expect(isHiddenAsIgnored(null, true)).toBe(false);
  });
});
