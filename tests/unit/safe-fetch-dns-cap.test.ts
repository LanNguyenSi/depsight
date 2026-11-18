// Tests for the user-host DNS lookup cap in lib/net/safe-fetch.ts.
// The counter and the FIFO wait queue live on globalThis (one shared state
// object for the whole process), so every test resets them through the
// exported test helper after re-importing the module. dns.lookup is mocked;
// http/https are mocked so a dial would be visible as a call.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { dnsLookupsInFlightForTests } from '@/lib/net/safe-fetch';

const { dnsLookupMock, httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn(),
}));

vi.mock('dns/promises', () => ({
  default: { lookup: dnsLookupMock },
  lookup: dnsLookupMock,
}));

vi.mock('http', () => {
  const mock = { request: httpRequestMock };
  return { default: mock, ...mock };
});

vi.mock('https', () => {
  const mock = { request: httpsRequestMock };
  return { default: mock, ...mock };
});

type SafeFetchModule = typeof import('@/lib/net/safe-fetch');

/**
 * A fresh module instance with the process-wide lookup state reset to empty
 * (the state itself lives on globalThis, so re-importing alone would share
 * it with any earlier copy).
 */
async function freshModule(): Promise<SafeFetchModule> {
  vi.resetModules();
  const mod = await import('@/lib/net/safe-fetch');
  mod.resetDnsLookupStateForTests();
  return mod;
}

/**
 * Mock dns.lookup so each hostname parks until the test settles it by name,
 * the way a real resolver is eventually done (with success or failure).
 */
function deferredResolver(): Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
> {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  dnsLookupMock.mockImplementation(
    (hostname: string) =>
      new Promise((resolve, reject) => {
        pending.set(hostname, { resolve, reject });
      }),
  );
  return pending;
}

/** Capture the settled outcome without leaving a rejection unhandled. */
function track<T>(p: Promise<T>): { outcome: () => { ok: boolean; value: unknown } | null } {
  let out: { ok: boolean; value: unknown } | null = null;
  p.then(
    (value) => (out = { ok: true, value }),
    (value) => (out = { ok: false, value }),
  );
  return { outcome: () => out };
}

/** Let queued microtasks (the release reactions) run. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Fill both slots with parked lookups. */
async function fillCap(mod: SafeFetchModule, pending: Map<string, { reject: (e: Error) => void }>) {
  mod.assertPublicUrl('https://slow1.example', { dnsTimeoutMs: 5000 }).catch(() => {});
  mod.assertPublicUrl('https://slow2.example', { dnsTimeoutMs: 5000 }).catch(() => {});
  await flush();
  expect(pending.has('slow1.example')).toBe(true);
  expect(pending.has('slow2.example')).toBe(true);
}

/** Settle the parked fill lookups so no slot (or rejection) outlives the test. */
async function drainCap(pending: Map<string, { reject: (e: Error) => void }>): Promise<void> {
  pending.get('slow1.example')?.reject(new Error('resolver gave up'));
  pending.get('slow2.example')?.reject(new Error('resolver gave up'));
  await flush();
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

/** Persistent https.request fake answering every request with a tiny 200. */
function dialWith200(): void {
  httpsRequestMock.mockImplementation((_options: unknown, callback: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.end = vi.fn();
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string>;
    };
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headers = { 'content-length': '2' };
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from('ok'));
        res.emit('end');
      });
    });
    return req;
  });
}

afterEach(() => {
  dnsLookupMock.mockReset();
  httpRequestMock.mockReset();
  httpsRequestMock.mockReset();
  vi.useRealTimers();
});

afterEach(() => {
  expect(dnsLookupsInFlightForTests()).toBe(0); // no slot leaks out of a test
});

describe('user-host DNS lookup cap', () => {
  it('the cap is a named constant below the default libuv pool size of 4', async () => {
    const mod = await freshModule();
    expect(mod.MAX_CONCURRENT_DNS_LOOKUPS).toBe(2);
    expect(mod.MAX_CONCURRENT_DNS_LOOKUPS).toBeLessThan(4);
  });

  it('rejects immediately with kind dns_busy when the cap is full, without calling dns.lookup', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    const t1 = track(mod.assertPublicUrl('https://slow1.example', { dnsTimeoutMs: 5000 }));
    const t2 = track(mod.assertPublicUrl('https://slow2.example', { dnsTimeoutMs: 5000 }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    const err = await mod
      .assertPublicUrl('https://third.example', { dnsTimeoutMs: 5000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(mod.SafeFetchLimitError);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // the cap rejected before the lookup
    expect(t1.outcome()).toBeNull(); // the two held lookups are untouched
    expect(t2.outcome()).toBeNull();

    await drainCap(pending);
  });

  it('releases the slot when a lookup succeeds: a later lookup is admitted', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    const t1 = track(mod.assertPublicUrl('https://a.example', { dnsTimeoutMs: 5000 }));
    const t2 = track(mod.assertPublicUrl('https://b.example', { dnsTimeoutMs: 5000 }));

    pending.get('a.example')!.resolve(PUBLIC);
    pending.get('b.example')!.resolve(PUBLIC);
    await flush(); // let the release reactions run
    expect(t1.outcome()?.ok).toBe(true);
    expect(t2.outcome()?.ok).toBe(true);

    const t3 = track(mod.assertPublicUrl('https://c.example', { dnsTimeoutMs: 5000 }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(3); // admitted, not dns_busy
    expect(t3.outcome()).toBeNull();
    pending.get('c.example')!.resolve(PUBLIC);
    expect(t3.outcome()).toBeNull();
    await flush();
  });

  it('releases the slot when a lookup errors: a later lookup is admitted', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    const t1 = track(mod.assertPublicUrl('https://a.example', { dnsTimeoutMs: 5000 }));
    const t2 = track(mod.assertPublicUrl('https://b.example', { dnsTimeoutMs: 5000 }));

    pending.get('a.example')!.reject(new Error('ENOTFOUND'));
    pending.get('b.example')!.reject(new Error('ENOTFOUND'));
    await flush();
    expect(t1.outcome()?.value).toBeInstanceOf(mod.SsrfBlockedError);
    expect(t2.outcome()?.value).toBeInstanceOf(mod.SsrfBlockedError);

    const t3 = track(mod.assertPublicUrl('https://c.example', { dnsTimeoutMs: 5000 }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(3);
    pending.get('c.example')!.resolve(PUBLIC);
    await flush();
    expect(t3.outcome()?.ok).toBe(true);
  });

  it('the slot is released on the late settle after a timeout, not when the timeout fires', async () => {
    vi.useFakeTimers();
    const mod = await freshModule();
    const pending = deferredResolver();
    const t1 = track(mod.assertPublicUrl('https://slow1.example', { dnsTimeoutMs: 500 }));
    const t2 = track(mod.assertPublicUrl('https://slow2.example', { dnsTimeoutMs: 500 }));

    await vi.advanceTimersByTimeAsync(500);
    expect((t1.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
      'timeout',
    );

    // The timeout released the caller but not the abandoned lookup: both
    // slots are still held until the resolvers themselves settle.
    const busy1 = await mod
      .assertPublicUrl('https://next.example', { dnsTimeoutMs: 500 })
      .catch((e) => e);
    expect((busy1 as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    // A late settle with an answer (long after the bound) releases the slot.
    pending.get('slow1.example')!.resolve(PUBLIC);
    await vi.advanceTimersByTimeAsync(0); // let the release reaction run
    const t3 = track(mod.assertPublicUrl('https://next.example', { dnsTimeoutMs: 500 }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(3); // admitted only after the late settle
    expect(httpsRequestMock).not.toHaveBeenCalled(); // the late answer was not dialed on

    // next.example itself now runs out its bound and settles late with an
    // error: that settle must release the slot too.
    await vi.advanceTimersByTimeAsync(500);
    expect((t3.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
      'timeout',
    );
    const busy2 = await mod
      .assertPublicUrl('https://late.example', { dnsTimeoutMs: 500 })
      .catch((e) => e);
    expect((busy2 as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect(dnsLookupMock).toHaveBeenCalledTimes(3); // still held: the error had not arrived

    pending.get('next.example')!.reject(new Error('resolver gave up')); // late settle (error)
    await vi.advanceTimersByTimeAsync(0);
    const t4 = track(mod.assertPublicUrl('https://late.example', { dnsTimeoutMs: 500 }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(4); // admitted only after the late error settle

    pending.get('late.example')!.resolve(PUBLIC);
    pending.get('slow2.example')!.reject(new Error('resolver gave up'));
    await vi.advanceTimersByTimeAsync(600);
    expect(t4.outcome()?.ok).toBe(true);
    expect((t2.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
      'timeout',
    );
  });

  it('a synchronous throw from dns.lookup releases the slot too', async () => {
    const mod = await freshModule();
    dnsLookupMock.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    await expect(
      mod.assertPublicUrl('https://boom.example', { dnsTimeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(mod.SsrfBlockedError);

    // The slot came straight back: two more lookups fit in flight at once.
    const pending = deferredResolver();
    const t1 = track(mod.assertPublicUrl('https://n1.example', { dnsTimeoutMs: 5000 }));
    const t2 = track(mod.assertPublicUrl('https://n2.example', { dnsTimeoutMs: 5000 }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(3); // neither was refused with dns_busy
    expect(t1.outcome()).toBeNull();
    expect(t2.outcome()).toBeNull();

    pending.get('n1.example')!.reject(new Error('cleanup'));
    pending.get('n2.example')!.reject(new Error('cleanup'));
    await flush();
  });

  it('a late lookup result after the timeout neither dials nor causes an unhandled rejection', async () => {
    const mod = await freshModule();
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = deferredResolver();
      const t1 = track(mod.safeFetch('https://slow1.example/hook', undefined, { timeoutMs: 30 }));
      const t2 = track(mod.safeFetch('https://slow2.example/hook', undefined, { timeoutMs: 30 }));

      await new Promise((r) => setTimeout(r, 80)); // real timers: the bound has fired
      expect((t1.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
        'timeout',
      );
      expect((t2.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
        'timeout',
      );

      // The resolvers finally answer: one with an address, one with an error.
      pending.get('slow1.example')!.resolve(PUBLIC);
      pending.get('slow2.example')!.reject(new Error('resolver gave up'));
      await new Promise((r) => setTimeout(r, 80)); // let any unhandled rejection surface

      expect(httpsRequestMock).not.toHaveBeenCalled();
      expect(httpRequestMock).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);

      // Both late settles released their slots, so a new lookup is admitted.
      dnsLookupMock.mockResolvedValueOnce(PUBLIC);
      const result = await mod.assertPublicUrl('https://after.example', { dnsTimeoutMs: 5000 });
      expect(result.addresses).toEqual(['93.184.216.34']);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('user-host DNS lookup cap: precedence', () => {
  it('a malformed URL wins over a full cap: it keeps its own block message, no lookup needed', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    await expect(mod.assertPublicUrl('not a url')).rejects.toBeInstanceOf(mod.SsrfBlockedError);
    await expect(mod.assertPublicUrl('not a url')).rejects.toThrow('Invalid URL format');
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    await drainCap(pending);
  });

  it('an SSRF-blocked IP literal wins over a full cap: it keeps its block message, no lookup needed', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    await expect(mod.assertPublicUrl('http://127.0.0.1/hook')).rejects.toThrow(
      'URL resolves to a non-public address',
    );
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    await drainCap(pending);
  });

  it('a full cap wins over a timeout: the caller is refused with dns_busy at once, before any timer can fire', async () => {
    vi.useFakeTimers();
    const mod = await freshModule();
    const pending = deferredResolver();
    mod.assertPublicUrl('https://slow1.example', { dnsTimeoutMs: 5000 }).catch(() => {});
    mod.assertPublicUrl('https://slow2.example', { dnsTimeoutMs: 5000 }).catch(() => {});
    const timersBefore = vi.getTimerCount(); // the two held lookups armed one timer each
    expect(timersBefore).toBe(2);

    const err = await mod
      .assertPublicUrl('https://third.example', { dnsTimeoutMs: 500 })
      .catch((e) => e);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect((err as Error).message).toBe('Already 2 host name lookups in flight');
    expect(vi.getTimerCount()).toBe(2); // no timeout timer was armed for the refused call
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    pending.get('slow1.example')!.reject(new Error('resolver gave up'));
    pending.get('slow2.example')!.reject(new Error('resolver gave up'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a full cap wins over the private address a refused host would have resolved to', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    // This host would resolve to a private IP, but the full cap refuses the
    // lookup before the resolver is asked, so dns_busy wins over the block.
    const err = await mod.assertPublicUrl('https://private.example').catch((e) => e);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    await drainCap(pending);
  });

  it('one lookup in flight does not trip the cap: a slow host still times out with kind timeout', async () => {
    vi.useFakeTimers();
    const mod = await freshModule();
    const pending = deferredResolver();
    const t1 = track(mod.assertPublicUrl('https://slow1.example', { dnsTimeoutMs: 5000 }));

    const t2 = track(mod.assertPublicUrl('https://slow2.example', { dnsTimeoutMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    expect((t2.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
      'timeout',
    );
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    pending.get('slow1.example')!.reject(new Error('resolver gave up'));
    pending.get('slow2.example')!.reject(new Error('resolver gave up'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t1.outcome()?.value).toBeInstanceOf(mod.SsrfBlockedError);
  });

  it('an empty cap never refuses: literal IPs and malformed URLs consume no slot', async () => {
    const mod = await freshModule();
    await expect(mod.assertPublicUrl('not a url')).rejects.toBeInstanceOf(mod.SsrfBlockedError);
    await expect(mod.assertPublicUrl('http://127.0.0.1')).rejects.toBeInstanceOf(
      mod.SsrfBlockedError,
    );
    expect(dnsLookupMock).not.toHaveBeenCalled();

    // With no lookup in flight, a hostname lookup goes straight through.
    dnsLookupMock.mockResolvedValue(PUBLIC);
    const result = await mod.assertPublicUrl('https://example.com');
    expect(result.addresses).toEqual(['93.184.216.34']);
  });
});

describe('delivery-mode wait queue (waitForSlot: true)', () => {
  it('a third delivery waits for a slot and proceeds when one frees', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending); // slow1 + slow2 hold both slots
    dialWith200();

    const t3 = track(mod.safeFetch('https://w3.example/hook', undefined, { timeoutMs: 5000 }));
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // it is waiting, not refused, not dialing
    expect(mod.dnsLookupQueueLengthForTests()).toBe(1);
    expect(httpsRequestMock).not.toHaveBeenCalled();

    pending.get('slow1.example')!.resolve(PUBLIC); // a slot frees
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(3); // the slot went to the waiter
    expect(mod.dnsLookupQueueLengthForTests()).toBe(0);
    expect(t3.outcome()).toBeNull(); // its own lookup is still parked
    expect(httpsRequestMock).not.toHaveBeenCalled();

    pending.get('w3.example')!.resolve(PUBLIC);
    await flush();
    expect(t3.outcome()?.ok).toBe(true);
    expect(httpsRequestMock).toHaveBeenCalledTimes(1); // it dialed exactly once
    pending.get('slow2.example')!.reject(new Error('cleanup'));
    await flush();
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
  });

  it('a waiter that cannot get a slot within its budget rejects with kind timeout', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    const err = await mod
      .safeFetch('https://w.example/hook', undefined, { timeoutMs: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(mod.SafeFetchLimitError);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('timeout');
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // it never got to look up
    expect(mod.dnsLookupQueueLengthForTests()).toBe(0);
    expect(httpsRequestMock).not.toHaveBeenCalled();

    await drainCap(pending);
  });

  it('a delivery that gets its slot late keeps one budget: its lookup times out at the delivery bound, not a fresh one', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending); // slow1 + slow2 hold both slots

    const startedAt = Date.now();
    const t = track(mod.safeFetch('https://late-w.example/hook', undefined, { timeoutMs: 200 }));
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // it is waiting for a slot

    await new Promise((r) => setTimeout(r, 150)); // most of the budget spent waiting
    pending.get('slow1.example')!.resolve(PUBLIC); // a slot frees late
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(3); // the waiter got the slot and looked up
    expect(httpsRequestMock).not.toHaveBeenCalled();

    // One budget covers queue wait and lookup: the lookup runs with only the
    // ~50 ms left of the delivery's 200 ms, so the delivery rejects with kind
    // timeout at about timeoutMs from its start, not a fresh 200 ms after the
    // grant (which is what arming the lookup with dnsTimeoutMs would do).
    while (t.outcome() === null && Date.now() - startedAt < 250) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const elapsed = Date.now() - startedAt;
    expect(t.outcome()).not.toBeNull();
    expect((t.outcome()?.value as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe(
      'timeout',
    );
    expect(elapsed).toBeLessThan(260);
    expect(httpsRequestMock).not.toHaveBeenCalled(); // nothing dialled on the timed-out lookup

    pending.get('late-w.example')!.reject(new Error('cleanup')); // the abandoned lookup settles
    await drainCap(pending);
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
  });

  it('slots go to waiters in FIFO order', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    const t1 = track(
      mod.assertPublicUrl('https://w1.example', { dnsTimeoutMs: 5000, waitForSlot: true }),
    );
    const t2 = track(
      mod.assertPublicUrl('https://w2.example', { dnsTimeoutMs: 5000, waitForSlot: true }),
    );
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);
    expect(mod.dnsLookupQueueLengthForTests()).toBe(2);

    pending.get('slow1.example')!.resolve(PUBLIC); // first release
    await flush();
    const looked = dnsLookupMock.mock.calls.map((c) => c[0]);
    expect(looked).toContain('w1.example'); // the head of the queue got the slot
    expect(looked).not.toContain('w2.example'); // not the waiter behind it
    expect(mod.dnsLookupQueueLengthForTests()).toBe(1);

    pending.get('slow2.example')!.resolve(PUBLIC); // second release
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(4); // now w2 is served too

    pending.get('w1.example')!.resolve(PUBLIC);
    pending.get('w2.example')!.resolve(PUBLIC);
    await flush();
    expect(t1.outcome()?.ok).toBe(true);
    expect(t2.outcome()?.ok).toBe(true);
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
  });

  it('a waiter beyond the queue cap is refused with dns_busy without queueing', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    const waiters = Array.from({ length: mod.MAX_QUEUED_DNS_LOOKUPS }, (_, i) =>
      track(
        mod.assertPublicUrl(`https://q${i}.example`, {
          dnsTimeoutMs: 60_000,
          waitForSlot: true,
        }),
      ),
    );
    await flush();
    expect(mod.dnsLookupQueueLengthForTests()).toBe(mod.MAX_QUEUED_DNS_LOOKUPS);

    const err = await mod
      .assertPublicUrl('https://overflow.example', { dnsTimeoutMs: 60_000, waitForSlot: true })
      .catch((e) => e);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect((err as Error).message).toBe(
      `Already ${mod.MAX_QUEUED_DNS_LOOKUPS} host name lookups queued`,
    );
    expect(mod.dnsLookupQueueLengthForTests()).toBe(mod.MAX_QUEUED_DNS_LOOKUPS); // refused before queueing
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    // Drain: every release grants the head of the queue, so the releases
    // cascade one wave of admissions per flush until everyone is served.
    for (let i = 0; i <= mod.MAX_QUEUED_DNS_LOOKUPS; i += 1) {
      for (const p of [...pending.values()]) p.resolve(PUBLIC);
      await flush();
    }
    expect(waiters.every((w) => w.outcome()?.ok === true)).toBe(true);
    expect(mod.dnsLookupQueueLengthForTests()).toBe(0);
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
  });

  it('a waiter that timed out left the queue and never takes a slot later', async () => {
    const mod = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod, pending);

    const err = await mod
      .assertPublicUrl('https://gone.example', { dnsTimeoutMs: 50, waitForSlot: true })
      .catch((e) => e);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('timeout');
    expect(mod.dnsLookupQueueLengthForTests()).toBe(0);

    // The held lookups settle now: with the timed-out waiter gone, the
    // releases free the counter instead of handing slots to a dead waiter.
    await drainCap(pending);
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // gone.example never looked up

    dnsLookupMock.mockResolvedValueOnce(PUBLIC);
    const result = await mod.assertPublicUrl('https://next.example'); // route mode
    expect(result.addresses).toEqual(['93.184.216.34']);
  });
});

describe('the cap counter cannot go negative', () => {
  it('the double release of a lookup that failed inside the bound is a no-op', async () => {
    const mod = await freshModule();
    // Two lookups fail inside the bound: the catch path releases and the
    // lookup's own rejection handler reaches release a second time.
    dnsLookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      mod.assertPublicUrl('https://f1.example', { dnsTimeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(mod.SsrfBlockedError);
    await expect(
      mod.assertPublicUrl('https://f2.example', { dnsTimeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(mod.SsrfBlockedError);
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);

    // Fill the cap with two parked lookups (calls 3 and 4). Without the
    // idempotence guard the counter would sit at -2 here, so the third check
    // below would be admitted and look up a fifth time.
    const pending = deferredResolver();
    await fillCap(mod, pending);
    const err = await mod
      .assertPublicUrl('https://fifth.example', { dnsTimeoutMs: 5000 })
      .catch((e) => e);
    expect((err as InstanceType<typeof mod.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect(dnsLookupMock).toHaveBeenCalledTimes(4); // not a fifth time

    await drainCap(pending);
    expect(mod.dnsLookupsInFlightForTests()).toBe(0);
  });
});

describe('the lookup state is process-wide (globalThis)', () => {
  it('two module copies share one counter; either copy can reset it', async () => {
    const mod1 = await freshModule();
    const pending = deferredResolver();
    await fillCap(mod1, pending);

    vi.resetModules();
    const mod2 = await import('@/lib/net/safe-fetch');
    expect(mod2.dnsLookupsInFlightForTests()).toBe(2); // mod1's lookups are visible to mod2

    const err = await mod2
      .assertPublicUrl('https://third.example', { dnsTimeoutMs: 5000 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(mod2.SafeFetchLimitError);
    expect((err as InstanceType<typeof mod2.SafeFetchLimitError>).kind).toBe('dns_busy');
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // refused by the other copy's lookups

    // Settle the two held lookups before the reset: resetting while they are
    // in flight would leave their late releases decrementing a counter that
    // the reset already zeroed, driving it to -2.
    pending.get('slow1.example')?.reject(new Error('cleanup'));
    pending.get('slow2.example')?.reject(new Error('cleanup'));
    await flush();
    expect(mod1.dnsLookupsInFlightForTests()).toBe(0);

    mod2.resetDnsLookupStateForTests(); // reset through either copy resets both
    expect(mod1.dnsLookupsInFlightForTests()).toBe(0);
  });
});
