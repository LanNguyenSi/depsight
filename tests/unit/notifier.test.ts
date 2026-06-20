import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks so vi.mock factories can reference them
const { webhookConfigFindMany, slackConfigFindUnique, safeFetchMock } = vi.hoisted(() => ({
  webhookConfigFindMany: vi.fn(),
  slackConfigFindUnique: vi.fn(),
  safeFetchMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookConfig: {
      findMany: webhookConfigFindMany,
    },
    slackConfig: {
      findUnique: slackConfigFindUnique,
    },
  },
}));

vi.mock('@/lib/net/safe-fetch', () => ({
  safeFetch: safeFetchMock,
  // Minimal stub — deliverWebhook only uses instanceof check in the catch path
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { notifyScanCompleted, notifyForScan } from '@/lib/alerts/notifier';
import type { Advisory } from '@prisma/client';

describe('notifyScanCompleted', () => {
  beforeEach(() => {
    webhookConfigFindMany.mockReset();
    safeFetchMock.mockReset();
  });

  it('delivers only to scan.completed subscribers with a correctly shaped payload', async () => {
    webhookConfigFindMany.mockResolvedValue([
      { url: 'https://hooks.example.com/scan', secret: null, events: ['scan.completed'] },
      { url: 'https://hooks.example.com/cve', secret: null, events: ['cve.critical'] },
    ]);
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const violations = [
      {
        policyName: 'no-gpl',
        severity: 'HIGH',
        message: 'GPL license detected',
        affectedPackages: ['lib-gpl@1.0.0 (GPL-3.0)'],
      },
    ];

    await notifyScanCompleted(
      'user-1',
      'repo-1',
      'acme/web',
      'scan-abc',
      'license',
      { licenseCount: 3, conflictCount: 1 },
      violations,
    );

    // Only one fetch call — for the scan.completed subscriber
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/scan',
      expect.objectContaining({ method: 'POST' }),
    );

    // Verify the cve-only subscriber was NOT called
    const calledUrls = safeFetchMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledUrls).not.toContain('https://hooks.example.com/cve');

    // Validate body shape
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.event).toBe('scan.completed');
    expect(body.scanType).toBe('license');
    expect(body.repoFullName).toBe('acme/web');
    expect(body.repoId).toBe('repo-1');
    expect(body.scanId).toBe('scan-abc');
    expect(body.policyViolations).toEqual(violations);
    expect(typeof body.scannedAt).toBe('string');
  });

  it('returns early without any fetch when no scan.completed subscribers exist', async () => {
    webhookConfigFindMany.mockResolvedValue([
      { url: 'https://hooks.example.com/cve', secret: null, events: ['cve.critical'] },
      { url: 'https://hooks.example.com/high', secret: null, events: ['cve.high'] },
    ]);

    await notifyScanCompleted('user-1', 'repo-1', 'acme/web', 'scan-xyz', 'cve', {}, []);

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('returns early without any fetch when the webhook list is empty', async () => {
    webhookConfigFindMany.mockResolvedValue([]);

    await notifyScanCompleted('user-1', 'repo-1', 'acme/web', 'scan-xyz', 'deps', {}, []);

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('delivers to ALL scan.completed subscribers when multiple are registered', async () => {
    webhookConfigFindMany.mockResolvedValue([
      { url: 'https://hooks.example.com/a', secret: null, events: ['scan.completed'] },
      { url: 'https://hooks.example.com/b', secret: 'mysecret', events: ['scan.completed', 'cve.critical'] },
    ]);
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyScanCompleted('user-1', 'repo-1', 'acme/web', 'scan-multi', 'cve', { cveCount: 2 }, []);

    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    const calledUrls = safeFetchMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledUrls).toContain('https://hooks.example.com/a');
    expect(calledUrls).toContain('https://hooks.example.com/b');
  });
});

describe('notifyForScan', () => {
  beforeEach(() => {
    webhookConfigFindMany.mockReset();
    slackConfigFindUnique.mockReset();
    safeFetchMock.mockReset();
  });

  it('delivers ONLY to cve.critical subscribers, not to scan.completed-only subscribers', async () => {
    // One webhook subscribed only to scan.completed, one to cve.critical.
    // notifyForScan fires a cve.critical event; the scan.completed-only
    // webhook must NOT be invoked. This test fails if the
    // `|| wh.events.includes('scan.completed')` clause is restored in the filter.
    webhookConfigFindMany.mockResolvedValue([
      { url: 'https://hooks.example.com/scan-only', secret: null, events: ['scan.completed'], enabled: true },
      { url: 'https://hooks.example.com/cve-critical', secret: null, events: ['cve.critical'], enabled: true },
    ]);
    slackConfigFindUnique.mockResolvedValue(null);
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const advisories = [
      {
        id: 'adv-1',
        ghsaId: 'GHSA-0000-0000-0001',
        cveId: 'CVE-2024-0001',
        severity: 'CRITICAL',
        summary: 'Remote code execution in example-pkg',
        packageName: 'example-pkg',
        fixedVersion: '2.0.0',
        url: 'https://github.com/advisories/GHSA-0000-0000-0001',
      },
    ] as unknown as Advisory[];

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-crit', 50, advisories);

    // Exactly one delivery: to the cve.critical subscriber
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/cve-critical',
      expect.objectContaining({ method: 'POST' }),
    );

    // The scan.completed-only webhook must NOT have been called
    const calledUrls = safeFetchMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledUrls).not.toContain('https://hooks.example.com/scan-only');
  });
});
