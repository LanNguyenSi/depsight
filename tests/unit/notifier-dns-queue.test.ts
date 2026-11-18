// Alert delivery through the REAL safeFetch and the real DNS lookup cap.
// Deliveries (unlike the save routes) wait for a lookup slot instead of
// being refused, so every webhook of one event is dialed even when they all
// start while the cap of 2 is full. dns.lookup answers instantly; https is
// mocked so a dial is visible as a call. A refuse-when-full shape would
// drop the third (and every later) webhook silently, because
// Promise.allSettled in the notifier ignores failed deliveries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { dnsLookupMock, httpRequestMock, httpsRequestMock, webhookConfigFindMany } = vi.hoisted(
  () => ({
    dnsLookupMock: vi.fn(),
    httpRequestMock: vi.fn(),
    httpsRequestMock: vi.fn(),
    webhookConfigFindMany: vi.fn(),
  }),
);

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

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookConfig: { findMany: webhookConfigFindMany },
    slackConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { notifyScanCompleted } from '@/lib/alerts/notifier';
import { dnsLookupsInFlightForTests, resetDnsLookupStateForTests } from '@/lib/net/safe-fetch';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

/** Every https.request is answered with a tiny 200, on the next ticks. */
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

function webhooksWithEvent(n: number, event: string) {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://hook${i}.example.com/deliver`,
    secret: null,
    events: [event],
    enabled: true,
  }));
}

beforeEach(() => {
  resetDnsLookupStateForTests();
  dnsLookupMock.mockReset();
  httpRequestMock.mockReset();
  httpsRequestMock.mockReset();
});

afterEach(() => {
  expect(dnsLookupsInFlightForTests()).toBe(0); // no slot leaks out of a test
});

describe('alert delivery with a full DNS lookup cap', () => {
  it.each([3, 5])(
    'all %i webhooks of one event are dialed with an instant resolver, none refused',
    async (n) => {
      dnsLookupMock.mockResolvedValue(PUBLIC); // instant resolver
      dialWith200();
      webhookConfigFindMany.mockResolvedValue(webhooksWithEvent(n, 'scan.completed'));

      await notifyScanCompleted('user-1', 'repo-1', 'acme/web', 'scan-1', 'cve', {}, []);

      // The cap of 2 is full from the moment the third delivery starts, yet
      // every delivery looks up its host and dials: none is refused with
      // dns_busy (which would silently drop it in Promise.allSettled).
      expect(dnsLookupMock).toHaveBeenCalledTimes(n);
      const looked = dnsLookupMock.mock.calls.map((c) => c[0]);
      for (let i = 0; i < n; i += 1) {
        expect(looked).toContain(`hook${i}.example.com`);
      }
      expect(httpsRequestMock).toHaveBeenCalledTimes(n);
    },
  );
});
