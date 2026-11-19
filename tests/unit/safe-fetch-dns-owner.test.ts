// Tests for the per-owner limit on the user-host DNS lookup slots in
// lib/net/safe-fetch.ts: one owner holds at most one of the two slots, its
// further callers queue, and a released slot goes to another owner's waiter
// before the same owner's next one. A caller without an owner keeps the
// global-cap-only behaviour. dns.lookup is mocked and parks per hostname
// until the test settles it.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  MAX_CONCURRENT_DNS_LOOKUPS,
  MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER,
  MAX_QUEUED_DNS_LOOKUPS,
  MAX_QUEUED_DNS_LOOKUPS_PER_OWNER,
  SafeFetchLimitError,
  assertPublicUrl,
  dnsLookupQueueLengthForTests,
  dnsLookupsHeldByOwnerForTests,
  dnsLookupsInFlightForTests,
  resetDnsLookupStateForTests,
} from '@/lib/net/safe-fetch';

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));

vi.mock('dns/promises', () => ({
  default: { lookup: dnsLookupMock },
  lookup: dnsLookupMock,
}));

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

type Parked = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** dns.lookup parks each hostname until the test settles it by name. */
function parkedResolver(): Map<string, Parked> {
  const pending = new Map<string, Parked>();
  dnsLookupMock.mockImplementation(
    (hostname: string) =>
      new Promise((resolve, reject) => {
        pending.set(hostname, { resolve, reject });
      }),
  );
  return pending;
}

function track<T>(p: Promise<T>): { outcome: () => { ok: boolean; value: unknown } | null } {
  let out: { ok: boolean; value: unknown } | null = null;
  p.then(
    (value) => (out = { ok: true, value }),
    (value) => (out = { ok: false, value }),
  );
  return { outcome: () => out };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const wait = { dnsTimeoutMs: 5000, waitForSlot: true } as const;

beforeEach(() => {
  resetDnsLookupStateForTests();
  dnsLookupMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  expect(dnsLookupsInFlightForTests()).toBe(0); // no slot leaks out of a test
  expect(dnsLookupsHeldByOwnerForTests('a')).toBe(0);
  expect(dnsLookupsHeldByOwnerForTests('b')).toBe(0);
});

/** Settle every parked lookup until nothing is left, so no slot or timer outlives the test. */
async function drain(pending: Map<string, Parked>): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    for (const p of pending.values()) p.resolve(PUBLIC);
    pending.clear();
    await flush();
  }
}

describe('per-owner DNS lookup limit', () => {
  it('the per-owner limit is a named constant below the global cap', () => {
    expect(MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER).toBe(1);
    expect(MAX_CONCURRENT_DNS_LOOKUPS_PER_OWNER).toBeLessThan(MAX_CONCURRENT_DNS_LOOKUPS);
  });

  it('the per-owner queue share is a named constant below the queue cap', () => {
    expect(MAX_QUEUED_DNS_LOOKUPS_PER_OWNER).toBe(32);
    expect(MAX_QUEUED_DNS_LOOKUPS_PER_OWNER).toBeLessThan(MAX_QUEUED_DNS_LOOKUPS);
  });

  it('an owner over its queue share is refused with dns_busy, another owner still queues', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://a-hold.example', { ...wait, owner: 'a' }));
    for (let i = 0; i < MAX_QUEUED_DNS_LOOKUPS_PER_OWNER; i += 1) {
      track(assertPublicUrl(`https://a-q${i}.example`, { ...wait, owner: 'a' }));
    }
    expect(dnsLookupQueueLengthForTests()).toBe(MAX_QUEUED_DNS_LOOKUPS_PER_OWNER);

    const over = await assertPublicUrl('https://a-over.example', { ...wait, owner: 'a' }).catch(
      (e) => e,
    );
    expect(over).toBeInstanceOf(SafeFetchLimitError);
    expect((over as SafeFetchLimitError).kind).toBe('dns_busy');
    expect((over as SafeFetchLimitError).message).toContain('for this owner');
    expect(dnsLookupQueueLengthForTests()).toBe(MAX_QUEUED_DNS_LOOKUPS_PER_OWNER); // not queued

    // The queue is only half full, so another owner finds places in it.
    track(assertPublicUrl('https://c-hold.example', { ...wait, owner: 'c' }));
    const b = track(assertPublicUrl('https://b1.example', { ...wait, owner: 'b' }));
    expect(dnsLookupQueueLengthForTests()).toBe(MAX_QUEUED_DNS_LOOKUPS_PER_OWNER + 1);
    expect(b.outcome()).toBeNull(); // queued, not refused
    await drain(pending);
    expect(b.outcome()?.ok).toBe(true);
  });

  it('callers without an owner are not bound by the owner queue share', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://x1.example', wait));
    track(assertPublicUrl('https://x2.example', wait));
    const waiting = MAX_QUEUED_DNS_LOOKUPS_PER_OWNER + 8;
    const all = Array.from({ length: waiting }, (_, i) =>
      track(assertPublicUrl(`https://xq${i}.example`, wait)),
    );
    expect(dnsLookupQueueLengthForTests()).toBe(waiting);
    expect(all.every((t) => t.outcome() === null)).toBe(true); // none refused
    await drain(pending);
    expect(all.every((t) => t.outcome()?.ok === true)).toBe(true);
  });

  it('a waiter of an owner that left the queue gives its share back', async () => {
    vi.useFakeTimers();
    parkedResolver();
    track(assertPublicUrl('https://a-hold.example', { ...wait, dnsTimeoutMs: 60_000, owner: 'a' }));
    const quick = Array.from({ length: MAX_QUEUED_DNS_LOOKUPS_PER_OWNER }, (_, i) =>
      track(assertPublicUrl(`https://a-q${i}.example`, { ...wait, dnsTimeoutMs: 1000, owner: 'a' })),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(quick.every((t) => (t.outcome()?.value as SafeFetchLimitError)?.kind === 'timeout')).toBe(true);
    expect(dnsLookupQueueLengthForTests()).toBe(0);
    const again = track(assertPublicUrl('https://a-again.example', { ...wait, owner: 'a' }));
    expect(dnsLookupQueueLengthForTests()).toBe(1); // queued, not refused
    expect(again.outcome()).toBeNull();
    resetDnsLookupStateForTests();
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('a state left on globalThis without owner counts (older shape) is upgraded, not thrown on', async () => {
    const pending = parkedResolver();
    const g = globalThis as Record<symbol, unknown>;
    g[Symbol.for('depsight.safeFetch.dnsLookups')] = { inFlight: 0, queued: [] };
    const a1 = track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
    expect(dnsLookupsHeldByOwnerForTests('a')).toBe(1);
    pending.get('a1.example')!.resolve(PUBLIC);
    await flush();
    expect(a1.outcome()?.ok).toBe(true);
  });

  it('a hand-off never grants a waiter whose owner already holds its limit', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://b1.example', { ...wait, owner: 'b' }));
    track(assertPublicUrl('https://b2.example', { ...wait, owner: 'b' }));
    pending.get('a1.example')!.resolve(PUBLIC);
    await flush();
    expect(dnsLookupsHeldByOwnerForTests('b')).toBe(1);
    expect(dnsLookupMock.mock.calls.map((c) => c[0])).not.toContain('b2.example');
    await drain(pending);
  });

  it('an owner-less release serves the first waiting owner-less caller before an owned one', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://x1.example', wait));
    track(assertPublicUrl('https://x2.example', wait));
    track(assertPublicUrl('https://x3.example', wait));
    track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    pending.get('x1.example')!.resolve(PUBLIC);
    await flush();
    expect(dnsLookupMock.mock.calls.map((c) => c[0]).slice(-1)).toEqual(['x3.example']);
    await drain(pending);
  });

  it('one owner takes one slot, its second caller queues, another owner takes the free slot', async () => {
    const pending = parkedResolver();
    const a1 = track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    const a2 = track(assertPublicUrl('https://a2.example', { ...wait, owner: 'a' }));
    const b1 = track(assertPublicUrl('https://b1.example', { ...wait, owner: 'b' }));

    expect(dnsLookupMock.mock.calls.map((c) => c[0])).toEqual(['a1.example', 'b1.example']);
    expect(dnsLookupsHeldByOwnerForTests('a')).toBe(1);
    expect(dnsLookupsHeldByOwnerForTests('b')).toBe(1);
    expect(dnsLookupQueueLengthForTests()).toBe(1); // a2 waits for its own owner, not for the global cap

    pending.get('b1.example')!.resolve(PUBLIC);
    pending.get('a1.example')!.resolve(PUBLIC);
    await flush();
    pending.get('a2.example')!.resolve(PUBLIC);
    await flush();
    expect(a1.outcome()?.ok).toBe(true);
    expect(a2.outcome()?.ok).toBe(true);
    expect(b1.outcome()?.ok).toBe(true);
  });

  it('a queued caller of the same owner is not served while the owner holds its slot, even with a free global slot', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://a2.example', { ...wait, owner: 'a' }));
    await flush();
    expect(dnsLookupsInFlightForTests()).toBe(1); // one global slot is free, a2 still waits
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);

    pending.get('a1.example')!.reject(new Error('resolver gave up'));
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // released: a2 got the slot
    pending.get('a2.example')!.resolve(PUBLIC);
    await flush();
  });

  it('a hand-off moves the owner slot: the new holder counts, so a later caller of that owner still queues', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://a2.example', { ...wait, owner: 'a' }));
    pending.get('a1.example')!.resolve(PUBLIC);
    await flush();
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // a2 holds the handed-over slot
    expect(dnsLookupsHeldByOwnerForTests('a')).toBe(1);

    track(assertPublicUrl('https://a3.example', { ...wait, owner: 'a' }));
    expect(dnsLookupMock).toHaveBeenCalledTimes(2); // a3 waits although a global slot is free
    expect(dnsLookupQueueLengthForTests()).toBe(1);
    pending.get('a2.example')!.resolve(PUBLIC);
    await flush();
    pending.get('a3.example')!.resolve(PUBLIC);
    await flush();
  });

  it('releases the owner slot when a lookup errors: the owner next caller is admitted', async () => {
    const pending = parkedResolver();
    const a1 = track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    const a2 = track(assertPublicUrl('https://a2.example', { ...wait, owner: 'a' }));
    await flush();
    pending.get('a1.example')!.reject(new Error('ENOTFOUND'));
    await flush();
    expect(a1.outcome()?.ok).toBe(false);
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);
    pending.get('a2.example')!.resolve(PUBLIC);
    await flush();
    expect(a2.outcome()?.ok).toBe(true);
  });

  it('the owner slot is freed when the lookup settles late, not when the bound fires', async () => {
    vi.useFakeTimers();
    const pending = parkedResolver();
    const a1 = track(assertPublicUrl('https://a1.example', { dnsTimeoutMs: 1000, owner: 'a' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect((a1.outcome()?.value as SafeFetchLimitError).kind).toBe('timeout');
    expect(dnsLookupsHeldByOwnerForTests('a')).toBe(1); // abandoned lookup still holds it
    pending.get('a1.example')!.resolve(PUBLIC);
    await vi.advanceTimersByTimeAsync(0);
    expect(dnsLookupsHeldByOwnerForTests('a')).toBe(0);
  });

  it('a waiter that runs out of its budget leaves the queue and its owner keeps no slot', async () => {
    vi.useFakeTimers();
    const pending = parkedResolver();
    track(assertPublicUrl('https://a1.example', { dnsTimeoutMs: 5000, waitForSlot: true, owner: 'a' }));
    const a2 = track(
      assertPublicUrl('https://a2.example', { dnsTimeoutMs: 1000, waitForSlot: true, owner: 'a' }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((a2.outcome()?.value as SafeFetchLimitError).kind).toBe('timeout');
    expect(dnsLookupQueueLengthForTests()).toBe(0);
    expect(dnsLookupsHeldByOwnerForTests('a')).toBe(1); // only a1
    pending.get('a1.example')!.resolve(PUBLIC);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a released slot goes to another owner waiting behind the releasing owner own waiters', async () => {
    const pending = parkedResolver();
    // c holds one slot, a the other; a has two more callers queued, b arrives last.
    track(assertPublicUrl('https://c1.example', { ...wait, owner: 'c' }));
    track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://a2.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://a3.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://b1.example', { ...wait, owner: 'b' }));
    expect(dnsLookupQueueLengthForTests()).toBe(3);

    pending.get('a1.example')!.resolve(PUBLIC);
    await flush();
    const looked = dnsLookupMock.mock.calls.map((c) => c[0]);
    expect(looked).toContain('b1.example'); // b ahead of a2 and a3
    expect(looked).not.toContain('a2.example');

    // Drain: every parked lookup is settled so nothing outlives the test.
    for (let i = 0; i < 10; i += 1) {
      for (const p of pending.values()) p.resolve(PUBLIC);
      pending.clear();
      await flush();
    }
  });

  it('falls back to the first waiter in FIFO order when only the releasing owner is waiting', async () => {
    const pending = parkedResolver();
    track(assertPublicUrl('https://c1.example', { ...wait, owner: 'c' }));
    track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://a2.example', { ...wait, owner: 'a' }));
    track(assertPublicUrl('https://a3.example', { ...wait, owner: 'a' }));
    pending.get('a1.example')!.resolve(PUBLIC);
    await flush();
    const looked = dnsLookupMock.mock.calls.map((c) => c[0]);
    expect(looked.slice(-1)).toEqual(['a2.example']); // a2 before a3
    for (let i = 0; i < 10; i += 1) {
      for (const p of pending.values()) p.resolve(PUBLIC);
      pending.clear();
      await flush();
    }
  });

  describe('owner and mode combinations', () => {
    it('without an owner only the global cap applies: two lookups run, the third queues', async () => {
      const pending = parkedResolver();
      track(assertPublicUrl('https://x1.example', wait));
      track(assertPublicUrl('https://x2.example', wait));
      track(assertPublicUrl('https://x3.example', wait));
      expect(dnsLookupMock).toHaveBeenCalledTimes(2);
      expect(dnsLookupQueueLengthForTests()).toBe(1);
      pending.get('x1.example')!.resolve(PUBLIC);
      pending.get('x2.example')!.resolve(PUBLIC);
      await flush();
      pending.get('x3.example')!.resolve(PUBLIC);
      await flush();
    });

    it('two different owners fill the global cap, a third owner queues', async () => {
      const pending = parkedResolver();
      track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
      track(assertPublicUrl('https://b1.example', { ...wait, owner: 'b' }));
      const c1 = track(assertPublicUrl('https://c1.example', { ...wait, owner: 'c' }));
      expect(dnsLookupMock).toHaveBeenCalledTimes(2);
      expect(c1.outcome()).toBeNull();
      for (const p of pending.values()) p.resolve(PUBLIC);
      pending.clear();
      await flush();
      pending.get('c1.example')!.resolve(PUBLIC);
      await flush();
    });

    it('refuse mode with an owner at its limit rejects dns_busy although a global slot is free', async () => {
      const pending = parkedResolver();
      track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
      const err = await assertPublicUrl('https://a2.example', {
        dnsTimeoutMs: 5000,
        waitForSlot: false,
        owner: 'a',
      }).catch((e) => e);
      expect((err as SafeFetchLimitError).kind).toBe('dns_busy');
      expect((err as SafeFetchLimitError).message).toContain('for this owner');
      expect(dnsLookupMock).toHaveBeenCalledTimes(1);
      pending.get('a1.example')!.resolve(PUBLIC);
      await flush();
    });

    it('an owner-less refuse-mode caller (a save route) is not affected by an owner at its limit', async () => {
      const pending = parkedResolver();
      track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
      const save = track(
        assertPublicUrl('https://save.example', { dnsTimeoutMs: 5000, waitForSlot: false }),
      );
      expect(dnsLookupMock).toHaveBeenCalledTimes(2);
      pending.get('save.example')!.resolve(PUBLIC);
      pending.get('a1.example')!.resolve(PUBLIC);
      await flush();
      expect(save.outcome()?.ok).toBe(true);
    });

    it('an owner-less holder does not count against any owner', async () => {
      const pending = parkedResolver();
      track(assertPublicUrl('https://x1.example', wait));
      track(assertPublicUrl('https://a1.example', { ...wait, owner: 'a' }));
      expect(dnsLookupMock).toHaveBeenCalledTimes(2);
      expect(dnsLookupsHeldByOwnerForTests('a')).toBe(1);
      pending.get('x1.example')!.resolve(PUBLIC);
      pending.get('a1.example')!.resolve(PUBLIC);
      await flush();
    });
  });
});
