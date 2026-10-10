// The cached lookup of GitHub's hook address ranges: lazy and bounded fetching,
// and a failure path that always ends in "not a GitHub address". The network is
// never touched; every fetch is an injected mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GITHUB_META_URL,
  HOOK_RANGES_FETCH_TIMEOUT_MS,
  HOOK_RANGES_MAX_BODY_BYTES,
  MIN_HOOK_PREFIX_IPV4,
  MIN_HOOK_PREFIX_IPV6,
  HOOK_RANGES_RETRY_MS,
  HOOK_RANGES_STALE_MS,
  HOOK_RANGES_TTL_MS,
  createHookRanges,
} from '@/lib/github-hook-ranges';

const IN_V4 = '192.30.252.10';
const IN_V6 = '2a0a:a440::10';
const OUT = '198.51.100.7';
const HOOKS = ['192.30.252.0/22', '2a0a:a440::/29'];

function meta(hooks: unknown): Response {
  return new Response(JSON.stringify({ hooks, web: ['10.0.0.0/8'] }));
}

describe('createHookRanges', () => {
  let clock: number;
  const now = () => clock;
  let fetchMock: ReturnType<typeof vi.fn>;

  function make(overrides: Parameters<typeof createHookRanges>[0] = {}) {
    return createHookRanges({ fetchImpl: fetchMock as unknown as typeof fetch, now, ...overrides });
  }

  beforeEach(() => {
    clock = 1_000_000;
    fetchMock = vi.fn(async () => meta(HOOKS));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('lazy fetch', () => {
    it('fetches nothing when created', () => {
      make();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers false and starts one fetch on the first lookup, then answers from the cache', async () => {
      const ranges = make();

      expect(ranges.contains(IN_V4)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(GITHUB_META_URL);
      expect(init.signal).toBeInstanceOf(AbortSignal);

      await ranges.refresh();

      expect(ranges.contains(IN_V4)).toBe(true);
      expect(ranges.contains(IN_V6)).toBe(true);
      expect(ranges.contains('::ffff:192.30.252.10')).toBe(true);
      expect(ranges.contains(OUT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a single fetch in flight however many lookups and refreshes arrive', async () => {
      let release: (res: Response) => void = () => undefined;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
      const ranges = make();

      for (let i = 0; i < 25; i++) ranges.contains(IN_V4);
      const a = ranges.refresh();
      const b = ranges.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      release(meta(HOOKS));
      await Promise.all([a, b]);
      expect(ranges.contains(IN_V4)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not fetch for something that is not an address', () => {
      const ranges = make();
      expect(ranges.contains('unknown')).toBe(false);
      expect(ranges.contains('')).toBe(false);
      expect(ranges.contains('fe80::1%eth0')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('looks global fetch up at call time when no fetch is injected', async () => {
      vi.stubGlobal('fetch', fetchMock);
      const ranges = createHookRanges({ now });
      await ranges.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ranges.contains(IN_V4)).toBe(true);
    });
  });

  describe('failure falls back to "not a GitHub address"', () => {
    const failures: Array<[string, () => Promise<Response>]> = [
      ['a network error', async () => Promise.reject(new Error('connect ECONNREFUSED'))],
      ['an HTTP error', async () => new Response('nope', { status: 503 })],
      ['a body that is not JSON', async () => new Response('<html>')],
      ['a body without hooks', async () => new Response(JSON.stringify({ web: ['10.0.0.0/8'] }))],
      ['hooks that is not a list', async () => meta('192.30.252.0/22')],
      ['an empty hooks list', async () => meta([])],
      ['hooks without one valid range', async () => meta(['junk', '1.2.3.4', 5, null, '1.2.3.4/99'])],
      [
        'more ranges than GitHub publishes',
        async () => meta(Array.from({ length: 501 }, (_, i) => `10.0.${i >> 8}.${i & 255}/32`)),
      ],
    ];

    for (const [name, impl] of failures) {
      it(`answers false for every address after ${name}`, async () => {
        fetchMock.mockImplementation(impl);
        const ranges = make();
        await ranges.refresh();
        for (const ip of [IN_V4, IN_V6, OUT, '10.0.0.1']) expect(ranges.contains(ip)).toBe(false);
      });
    }

    it('warns once and retries after the retry delay, not the TTL, when the response holds no valid range', async () => {
      fetchMock.mockImplementation(async () => meta(['junk', '1.2.3.4', '1.2.3.4/99']));
      const ranges = make();

      await ranges.refresh();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('no usable hooks ranges');
      expect(ranges.contains(IN_V4)).toBe(false);

      fetchMock.mockClear();
      clock += HOOK_RANGES_RETRY_MS - 1;
      for (let i = 0; i < 50; i++) ranges.contains(IN_V4);
      expect(fetchMock).not.toHaveBeenCalled();

      // A second unusable answer does not warn again; a good one is picked up right away.
      clock += 1;
      ranges.contains(IN_V4);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await ranges.refresh();
      expect(console.warn).toHaveBeenCalledTimes(1);

      fetchMock.mockImplementation(async () => meta(HOOKS));
      clock += HOOK_RANGES_RETRY_MS;
      ranges.contains(IN_V4);
      await ranges.refresh();
      expect(ranges.contains(IN_V4)).toBe(true);
    });

    it('warns once per run of failures and again after a success', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const ranges = make();

      await ranges.refresh();
      await ranges.refresh();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('down');

      fetchMock.mockImplementation(async () => meta(HOOKS));
      await ranges.refresh();
      fetchMock.mockRejectedValue(new Error('down again'));
      await ranges.refresh();
      expect(console.warn).toHaveBeenCalledTimes(2);
    });

    it('does not retry before the retry delay has passed, and retries after it', async () => {
      fetchMock.mockRejectedValue(new Error('down'));
      const ranges = make();

      ranges.contains(IN_V4);
      await ranges.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(1); // the explicit refresh joined the lookup's fetch

      fetchMock.mockClear();
      clock += HOOK_RANGES_RETRY_MS - 1;
      for (let i = 0; i < 50; i++) ranges.contains(IN_V4);
      expect(fetchMock).not.toHaveBeenCalled();

      clock += 1;
      ranges.contains(IN_V4);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('abandons a fetch that does not answer within the timeout', async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const ranges = make();

      const done = ranges.refresh();
      await vi.advanceTimersByTimeAsync(HOOK_RANGES_FETCH_TIMEOUT_MS - 1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(ranges.contains(IN_V4)).toBe(false);
      expect(console.warn).toHaveBeenCalledTimes(1);
      // The slot is free again: a later attempt can start.
      clock += HOOK_RANGES_RETRY_MS;
      fetchMock.mockImplementation(async () => meta(HOOKS));
      await ranges.refresh();
      expect(ranges.contains(IN_V4)).toBe(true);
    });

    it('keeps the valid entries of a response that also holds invalid ones', async () => {
      fetchMock.mockImplementation(async () => meta(['junk', IN_V4 + '/32', 7, '2a0a:a440::/129']));
      const ranges = make();
      await ranges.refresh();
      expect(ranges.contains(IN_V4)).toBe(true);
      expect(ranges.contains('192.30.252.11')).toBe(false);
      expect(ranges.contains(IN_V6)).toBe(false);
    });
  });

  describe('sanity floor on range width', () => {
    it('drops a range that would cover most of the Internet, so 0.0.0.0/0 and ::/0 classify nothing', async () => {
      fetchMock.mockImplementation(async () => meta(['0.0.0.0/0', '::/0']));
      const ranges = make();
      await ranges.refresh();

      for (const ip of [IN_V4, IN_V6, OUT, '10.0.0.1', '2001:db8::1']) expect(ranges.contains(ip)).toBe(false);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('keeps the narrow entries of a response that also holds a /0', async () => {
      fetchMock.mockImplementation(async () => meta(['0.0.0.0/0', ...HOOKS, '::/0']));
      const ranges = make();
      await ranges.refresh();

      expect(ranges.contains(IN_V4)).toBe(true);
      expect(ranges.contains(IN_V6)).toBe(true);
      expect(ranges.contains(OUT)).toBe(false);
      expect(ranges.contains('2001:db8::1')).toBe(false);
    });

    it('accepts the floor itself and rejects one bit wider', async () => {
      fetchMock.mockImplementation(async () =>
        meta([`10.0.0.0/${MIN_HOOK_PREFIX_IPV4}`, `11.0.0.0/${MIN_HOOK_PREFIX_IPV4 - 1}`, `3000::/${MIN_HOOK_PREFIX_IPV6}`, `4000::/${MIN_HOOK_PREFIX_IPV6 - 1}`]),
      );
      const ranges = make();
      await ranges.refresh();

      expect(ranges.contains('10.200.0.1')).toBe(true);
      expect(ranges.contains('11.0.0.1')).toBe(false);
      expect(ranges.contains('3000:1::1')).toBe(true);
      expect(ranges.contains('4000::1')).toBe(false);
    });
  });

  describe('size of the response', () => {
    const valid = JSON.stringify({ hooks: HOOKS });
    /** A valid meta document padded past the cap with an unrelated key. */
    const padded = JSON.stringify({ hooks: HOOKS, pad: 'x'.repeat(HOOK_RANGES_MAX_BODY_BYTES) });

    it('reads a body under the cap', async () => {
      const ranges = make();
      await ranges.refresh();
      expect(ranges.contains(IN_V4)).toBe(true);
    });

    it('uses a body of exactly the cap, with and without a matching Content-Length', async () => {
      const exact = JSON.stringify({ hooks: HOOKS, pad: '' });
      const body = exact.slice(0, -2) + 'x'.repeat(HOOK_RANGES_MAX_BODY_BYTES - exact.length) + '"}';
      expect(body.length).toBe(HOOK_RANGES_MAX_BODY_BYTES);
      for (const headers of [{}, { 'content-length': String(HOOK_RANGES_MAX_BODY_BYTES) }]) {
        fetchMock.mockImplementation(async () => new Response(body, { headers }));
        const ranges = make();
        await ranges.refresh();
        expect(ranges.contains(IN_V4)).toBe(true);
      }
    });

    it('does not use a body that exceeds the cap, however it is valid otherwise', async () => {
      expect(padded.length).toBeGreaterThan(HOOK_RANGES_MAX_BODY_BYTES);
      fetchMock.mockImplementation(async () => new Response(padded));
      const parse = vi.spyOn(JSON, 'parse');
      const ranges = make();
      await ranges.refresh();

      expect(ranges.contains(IN_V4)).toBe(false);
      expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('too large');
      expect(parse).not.toHaveBeenCalled();
    });

    it('stops reading a streamed body at the cap', async () => {
      let sent = 0;
      const chunk = new Uint8Array(256 * 1024).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      fetchMock.mockImplementation(async () => new Response(stream));
      const ranges = make();
      await ranges.refresh();

      expect(ranges.contains(IN_V4)).toBe(false);
      // The cap plus the read-ahead of the stream, never an unbounded body.
      expect(sent).toBeLessThanOrEqual(HOOK_RANGES_MAX_BODY_BYTES + 4 * chunk.byteLength);
    });

    it('refuses a response whose Content-Length is over the cap without parsing it', async () => {
      fetchMock.mockImplementation(
        async () =>
          new Response(valid, { headers: { 'content-length': String(HOOK_RANGES_MAX_BODY_BYTES + 1) } }),
      );
      const ranges = make();
      await ranges.refresh();

      expect(ranges.contains(IN_V4)).toBe(false);
      expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('too large');
    });
  });

  describe('bounded refresh', () => {
    it('refreshes once the ranges are older than the TTL, and not before', async () => {
      const ranges = make();
      await ranges.refresh();
      fetchMock.mockClear();

      clock += HOOK_RANGES_TTL_MS - 1;
      for (let i = 0; i < 50; i++) expect(ranges.contains(IN_V4)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      clock += 1;
      // The old ranges still answer while the refresh runs, and only one refresh starts.
      for (let i = 0; i < 50; i++) expect(ranges.contains(IN_V4)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('picks up changed ranges after a refresh', async () => {
      const ranges = make();
      await ranges.refresh();
      expect(ranges.contains(IN_V4)).toBe(true);
      expect(ranges.contains('140.82.112.3')).toBe(false);

      fetchMock.mockImplementation(async () => meta(['140.82.112.0/20']));
      clock += HOOK_RANGES_TTL_MS;
      ranges.contains(IN_V4);
      await ranges.refresh();

      expect(ranges.contains('140.82.112.3')).toBe(true);
      expect(ranges.contains(IN_V4)).toBe(false);
    });

    it('serves the old ranges while refreshes fail, and drops them after the stale limit', async () => {
      const ranges = make();
      await ranges.refresh();
      fetchMock.mockRejectedValue(new Error('down'));

      clock += HOOK_RANGES_TTL_MS;
      ranges.contains(IN_V4);
      await ranges.refresh();
      expect(ranges.contains(IN_V4)).toBe(true);

      clock += HOOK_RANGES_STALE_MS - HOOK_RANGES_TTL_MS - 1;
      expect(ranges.contains(IN_V4)).toBe(true);
      clock += 1;
      expect(ranges.contains(IN_V4)).toBe(false);
      expect(ranges.contains(IN_V6)).toBe(false);
    });

    it('forgets everything on reset', async () => {
      const ranges = make();
      await ranges.refresh();
      ranges.reset();
      fetchMock.mockClear();
      expect(ranges.contains(IN_V4)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
