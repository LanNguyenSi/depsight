// Alert delivery through the REAL safeFetch and the real DNS lookup slots,
// with two users. One user's hosts park their lookups (a resolver that never
// answers) while another user's host resolves at once: the second user's
// delivery must still be dialed within its budget, and the first user's
// deliveries must each still end in a dial or a logged failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { dnsLookupMock, httpsRequestMock, webhookConfigFindMany } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpsRequestMock: vi.fn(),
  webhookConfigFindMany: vi.fn(),
}));

vi.mock('dns/promises', () => ({
  default: { lookup: dnsLookupMock },
  lookup: dnsLookupMock,
}));

vi.mock('http', () => {
  const mock = { request: vi.fn() };
  return { default: mock, ...mock };
});

vi.mock('https', () => {
  const mock = { request: httpsRequestMock };
  return { default: mock, ...mock };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookConfig: { findMany: webhookConfigFindMany },
    slackConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { notifyScanCompleted } from '@/lib/alerts/notifier';
import {
  MAX_CONCURRENT_DNS_LOOKUPS,
  dnsLookupsHeldByOwnerForTests,
  dnsLookupsInFlightForTests,
  resetDnsLookupStateForTests,
} from '@/lib/net/safe-fetch';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

type Parked = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function dialWith200(): void {
  httpsRequestMock.mockImplementation(
    (_options: unknown, callback: (res: EventEmitter) => void) => {
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
    },
  );
}

/** Hosts of user A (`a-<n>.example.com`) park until settled; every other host resolves at once. */
function parkUserAHosts(): Map<string, Parked> {
  const pending = new Map<string, Parked>();
  dnsLookupMock.mockImplementation((hostname: string) => {
    if (hostname.startsWith('a-')) {
      return new Promise((resolve, reject) => {
        pending.set(hostname, { resolve, reject });
      });
    }
    return Promise.resolve(PUBLIC);
  });
  return pending;
}

function hooksOf(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://${prefix}-${i}.example.com/deliver`,
    secret: null,
    events: ['scan.completed'],
    enabled: true,
  }));
}

/** webhookConfig.findMany answers per user id. */
function webhooksByUser(byUser: Record<string, ReturnType<typeof hooksOf>>): void {
  webhookConfigFindMany.mockImplementation(
    async (args: { where: { userId: string } }) => byUser[args.where.userId] ?? [],
  );
}

function notify(userId: string): Promise<void> {
  return notifyScanCompleted(userId, 'repo-1', 'acme/web', 'scan-1', 'cve', {}, []);
}

function dialedHosts(): string[] {
  return httpsRequestMock.mock.calls.map((c) => (c[0] as { hostname: string }).hostname);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetDnsLookupStateForTests();
  dnsLookupMock.mockReset();
  httpsRequestMock.mockReset();
  webhookConfigFindMany.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
  expect(dnsLookupsInFlightForTests()).toBe(0); // no slot leaks out of a test
  expect(dnsLookupsHeldByOwnerForTests('user-a')).toBe(0);
  expect(dnsLookupsHeldByOwnerForTests('user-b')).toBe(0);
});

describe('alert delivery of two users against the shared DNS lookup slots', () => {
  it('user B is dialed while 66 webhooks of user A park their lookups', async () => {
    const pending = parkUserAHosts();
    dialWith200();
    webhooksByUser({ 'user-a': hooksOf('a', 66), 'user-b': hooksOf('b', 1) });

    const aDone = notify('user-a');
    await vi.advanceTimersByTimeAsync(0);
    // A holds one slot and the global cap of 2 leaves one for everybody else.
    expect(dnsLookupMock.mock.calls.filter((c) => String(c[0]).startsWith('a-'))).toHaveLength(1);
    expect(dnsLookupsHeldByOwnerForTests('user-a')).toBe(1);
    expect(dnsLookupsInFlightForTests()).toBeLessThan(MAX_CONCURRENT_DNS_LOOKUPS);

    const bDone = notify('user-b');
    await vi.advanceTimersByTimeAsync(0);
    await bDone; // resolves without any timer advance: no wait for a slot
    expect(dialedHosts()).toEqual(['b-0.example.com']);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('b-0.example.com'));

    // A's lookups finally answer: every one of A's queued deliveries proceeds.
    for (let i = 0; i < 70 && dialedHosts().length < 66; i += 1) {
      for (const [host, p] of [...pending]) {
        p.resolve(PUBLIC);
        pending.delete(host);
      }
      await vi.advanceTimersByTimeAsync(0);
    }
    await aDone;
    // 63 of A's 65 hooks got a place in the wait queue after the first took the
    // slot (queue cap 64: one more is refused with dns_busy), none was dropped
    // silently: every refusal is logged.
    const aDialed = dialedHosts().filter((h) => h.startsWith('a-'));
    const refused = warn.mock.calls.filter((c) => String(c[0]).includes('dns_busy'));
    expect(aDialed.length + refused.length).toBe(66);
    expect(refused.length).toBe(1);
  });

  it('each of A deliveries that never gets a lookup ends in a logged timeout, none is lost silently', async () => {
    const pending = parkUserAHosts();
    dialWith200();
    webhooksByUser({ 'user-a': hooksOf('a', 66) });

    const aDone = notify('user-a');
    await vi.advanceTimersByTimeAsync(15_000);
    await aDone;
    expect(httpsRequestMock).not.toHaveBeenCalled();
    const kinds = warn.mock.calls.map((c) => String(c[0]));
    // 1 parked lookup (timeout), 64 queued waiters (timeout), 1 over the queue cap (dns_busy).
    expect(kinds.filter((m) => m.includes('kind: timeout'))).toHaveLength(65);
    expect(kinds.filter((m) => m.includes('kind: dns_busy'))).toHaveLength(1);
    expect(kinds.every((m) => /a-\d+\.example\.com/.test(m))).toBe(true);

    // The abandoned lookup still holds A's slot until it settles, then it is released.
    expect(dnsLookupsHeldByOwnerForTests('user-a')).toBe(1);
    for (const p of pending.values()) p.resolve(PUBLIC);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('A first delivery throwing releases the slot: its second delivery is dialed', async () => {
    const pending = parkUserAHosts();
    dialWith200();
    webhooksByUser({ 'user-a': hooksOf('a', 2) });

    const aDone = notify('user-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(dnsLookupMock.mock.calls.map((c) => c[0])).toEqual(['a-0.example.com']);

    pending.get('a-0.example.com')!.reject(new Error('resolver exploded'));
    await vi.advanceTimersByTimeAsync(0);
    expect(dnsLookupMock.mock.calls.map((c) => c[0])).toEqual([
      'a-0.example.com',
      'a-1.example.com',
    ]);
    pending.get('a-1.example.com')!.resolve(PUBLIC);
    await vi.advanceTimersByTimeAsync(0);
    await aDone;

    expect(dialedHosts()).toEqual(['a-1.example.com']);
    expect(warn).toHaveBeenCalledTimes(1); // the first one, logged with its host
    expect(String(warn.mock.calls[0][0])).toContain('a-0.example.com');
  });

  it('concurrent notify calls of one user share the one slot limit', async () => {
    const pending = parkUserAHosts();
    dialWith200();
    webhooksByUser({ 'user-a': hooksOf('a', 3) });

    const first = notify('user-a');
    const second = notify('user-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(dnsLookupMock).toHaveBeenCalledTimes(1); // six deliveries, one lookup slot
    expect(dnsLookupsHeldByOwnerForTests('user-a')).toBe(1);

    for (let i = 0; i < 20 && dialedHosts().length < 6; i += 1) {
      for (const [host, p] of [...pending]) {
        p.resolve(PUBLIC);
        pending.delete(host);
      }
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all([first, second]);
    expect(dialedHosts()).toHaveLength(6);
  });
});
