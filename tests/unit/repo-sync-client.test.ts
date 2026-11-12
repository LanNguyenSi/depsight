import { describe, it, expect, vi } from 'vitest';
import {
  requestRepoSync,
  SYNC_FAILED_MESSAGE,
  SYNC_NETWORK_ERROR_MESSAGE,
} from '@/lib/repo-sync-client';

function fetchReturning(res: Response | Error) {
  return vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch;
}

describe('requestRepoSync', () => {
  it('posts to the sync route and reports success on 200', async () => {
    const f = fetchReturning(new Response('{}', { status: 200 }));
    expect(await requestRepoSync(f)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith('/api/repos/sync', { method: 'POST' });
  });

  it('returns the server error text on a 429', async () => {
    const f = fetchReturning(
      new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfterSeconds: 30 }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );
    expect(await requestRepoSync(f)).toEqual({ ok: false, error: 'Rate limit exceeded' });
  });

  it('falls back when a failing body is not JSON', async () => {
    const f = fetchReturning(new Response('<html>boom</html>', { status: 500 }));
    expect(await requestRepoSync(f)).toEqual({ ok: false, error: SYNC_FAILED_MESSAGE });
  });

  it('falls back when the JSON body has no usable error', async () => {
    for (const body of ['{}', '{"error":""}', '{"error":5}', 'null']) {
      const f = fetchReturning(new Response(body, { status: 502 }));
      expect(await requestRepoSync(f)).toEqual({ ok: false, error: SYNC_FAILED_MESSAGE });
    }
  });

  it('reports a network error when fetch rejects', async () => {
    const f = fetchReturning(new TypeError('failed to fetch'));
    expect(await requestRepoSync(f)).toEqual({ ok: false, error: SYNC_NETWORK_ERROR_MESSAGE });
  });
});
