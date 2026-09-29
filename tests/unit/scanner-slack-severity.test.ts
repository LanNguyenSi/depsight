import { describe, it, expect, vi, beforeEach } from 'vitest';

const { repoFindUnique, scanFindFirst, scanCreate, scanUpdate, advisoryFindMany, txMock, slackFindUnique, webhookFindMany, safeFetchMock } =
  vi.hoisted(() => ({
    repoFindUnique: vi.fn(),
    scanFindFirst: vi.fn(),
    scanCreate: vi.fn(),
    scanUpdate: vi.fn(),
    advisoryFindMany: vi.fn(),
    txMock: vi.fn(),
    slackFindUnique: vi.fn(),
    webhookFindMany: vi.fn(),
    safeFetchMock: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findUnique: repoFindUnique, update: vi.fn() },
    scan: { findFirst: scanFindFirst, create: scanCreate, update: scanUpdate },
    advisory: { createMany: vi.fn(), findMany: advisoryFindMany },
    $transaction: txMock,
    slackConfig: { findUnique: slackFindUnique },
    webhookConfig: { findMany: webhookFindMany },
  },
}));

vi.mock('@/lib/cve/github-advisories', () => ({
  fetchRepoAdvisories: vi.fn().mockResolvedValue({ advisories: [], dependabotDisabled: false }),
  buildScanResult: vi.fn().mockReturnValue({
    advisories: [],
    counts: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    riskScore: 0,
    dependabotDisabled: false,
  }),
}));
vi.mock('@/lib/cve/osv', () => ({
  fetchOsvAdvisories: vi.fn().mockResolvedValue({ advisories: [], ecosystem: 'npm' }),
}));
vi.mock('@/lib/cve/merge', () => ({ mergeCveAdvisories: vi.fn().mockReturnValue([]) }));
vi.mock('@/lib/net/safe-fetch', () => ({
  safeFetch: safeFetchMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock('@/lib/alerts/post-scan', () => ({ runPostScanHooks: vi.fn().mockResolvedValue(undefined) }));

import { scanRepository } from '@/lib/cve/scanner';

const REPO = {
  id: 'repo-1',
  userId: 'me',
  tracked: true,
  owner: 'acme',
  name: 'web',
  fullName: 'acme/web',
  defaultBranch: 'main',
};

// A stored scan holding only a MEDIUM advisory. The stand-in for the advisory
// table honours a `severity: { in: [...] }` filter, so a query that still
// prefilters to CRITICAL/HIGH would see nothing.
const STORED = [
  {
    id: 'a1',
    ghsaId: 'GHSA-1',
    cveId: null,
    severity: 'MEDIUM',
    summary: 'medium issue',
    packageName: 'pkg-medium',
    fixedVersion: null,
    url: null,
  },
];

describe('scanRepository Slack minimum severity', () => {
  beforeEach(() => {
    for (const m of [repoFindUnique, scanFindFirst, scanCreate, scanUpdate, advisoryFindMany, txMock, slackFindUnique, webhookFindMany, safeFetchMock]) {
      m.mockReset();
    }
    repoFindUnique.mockResolvedValue(REPO);
    scanFindFirst.mockResolvedValue(null);
    scanCreate.mockResolvedValue({ id: 'scan-1' });
    scanUpdate.mockResolvedValue({});
    webhookFindMany.mockResolvedValue([]);
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    txMock.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({
        advisory: { createMany: vi.fn() },
        scan: { update: scanUpdate },
        repo: { update: vi.fn() },
      });
    });
    advisoryFindMany.mockImplementation(async (args: { where: { severity?: { in: string[] } } }) => {
      const allowed = args.where.severity?.in;
      return STORED.filter((a) => !allowed || allowed.includes(a.severity));
    });
  });

  it('delivers a MEDIUM-only scan to Slack when the configured minimum is MEDIUM', async () => {
    slackFindUnique.mockResolvedValue({
      enabled: true,
      webhookUrl: 'https://hooks.slack.example/T/B/x',
      channel: null,
      minSeverity: 'MEDIUM',
    });

    await scanRepository('me', 'repo-1', 'tok');

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0][0]).toBe('https://hooks.slack.example/T/B/x');
    expect(String(safeFetchMock.mock.calls[0][1].body)).toContain('pkg-medium');
  });

  it('does not deliver a MEDIUM-only scan to Slack when the configured minimum is HIGH', async () => {
    slackFindUnique.mockResolvedValue({
      enabled: true,
      webhookUrl: 'https://hooks.slack.example/T/B/x',
      channel: null,
      minSeverity: 'HIGH',
    });

    await scanRepository('me', 'repo-1', 'tok');

    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
