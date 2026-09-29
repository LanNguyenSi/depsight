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

  const adv = (severity: string, n = 1) =>
    ({
      id: `adv-${severity}-${n}`,
      ghsaId: `GHSA-${severity}-${n}`,
      cveId: null,
      severity,
      summary: `${severity} issue`,
      packageName: `pkg-${severity}`,
      fixedVersion: null,
      url: null,
    }) as unknown as Advisory;

  const SLACK_URL = 'https://hooks.slack.example/T/B/x';
  const slackConfig = (minSeverity: string) => ({
    enabled: true,
    webhookUrl: SLACK_URL,
    channel: null,
    minSeverity,
  });
  const hooks = [
    { url: 'https://hooks.example.com/crit', secret: null, events: ['cve.critical'], enabled: true },
    { url: 'https://hooks.example.com/high', secret: null, events: ['cve.high'], enabled: true },
  ];
  const bodyOf = (call: unknown[]) =>
    JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  const callsTo = (url: string) => safeFetchMock.mock.calls.filter((c: unknown[]) => c[0] === url);

  it('emits cve.high, not cve.critical, when the worst advisory is HIGH', async () => {
    webhookConfigFindMany.mockResolvedValue(hooks);
    slackConfigFindUnique.mockResolvedValue(null);
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-h', 40, [adv('HIGH')]);

    expect(callsTo('https://hooks.example.com/crit')).toHaveLength(0);
    const high = callsTo('https://hooks.example.com/high');
    expect(high).toHaveLength(1);
    expect(bodyOf(high[0]).event).toBe('cve.high');
  });

  it('does not deliver to Slack when minSeverity is CRITICAL and the scan is HIGH-only', async () => {
    webhookConfigFindMany.mockResolvedValue([]);
    slackConfigFindUnique.mockResolvedValue(slackConfig('CRITICAL'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-h', 40, [adv('HIGH')]);

    expect(callsTo(SLACK_URL)).toHaveLength(0);
  });

  it('delivers a MEDIUM-only scan to Slack when minSeverity is MEDIUM', async () => {
    webhookConfigFindMany.mockResolvedValue([]);
    slackConfigFindUnique.mockResolvedValue(slackConfig('MEDIUM'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-m', 20, [adv('MEDIUM')]);

    const slack = callsTo(SLACK_URL);
    expect(slack).toHaveLength(1);
    expect(JSON.stringify(bodyOf(slack[0]))).toContain('pkg-MEDIUM');
  });

  it('does not deliver a MEDIUM-only scan to Slack when minSeverity is HIGH', async () => {
    webhookConfigFindMany.mockResolvedValue([]);
    slackConfigFindUnique.mockResolvedValue(slackConfig('HIGH'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-m', 20, [adv('MEDIUM')]);

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('keeps webhooks at CRITICAL/HIGH: no delivery for a MEDIUM-only scan, no MEDIUM in a mixed payload', async () => {
    webhookConfigFindMany.mockResolvedValue(hooks);
    slackConfigFindUnique.mockResolvedValue(slackConfig('LOW'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-m', 20, [adv('MEDIUM'), adv('LOW')]);
    expect(callsTo('https://hooks.example.com/crit')).toHaveLength(0);
    expect(callsTo('https://hooks.example.com/high')).toHaveLength(0);
    expect(callsTo(SLACK_URL)).toHaveLength(1);

    safeFetchMock.mockClear();
    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-x', 60, [adv('HIGH'), adv('MEDIUM')]);
    const high = callsTo('https://hooks.example.com/high');
    expect(high).toHaveLength(1);
    const listed = (bodyOf(high[0]).newAdvisories as Array<{ severity: string }>).map((a) => a.severity);
    expect(listed).toEqual(['HIGH']);
  });

  const slackBodyText = () => {
    const c = callsTo(SLACK_URL);
    expect(c).toHaveLength(1);
    return JSON.stringify(bodyOf(c[0]));
  };

  it('Slack HIGH lists only the HIGH package of a HIGH+MEDIUM scan and counts 1', async () => {
    webhookConfigFindMany.mockResolvedValue([]);
    slackConfigFindUnique.mockResolvedValue(slackConfig('HIGH'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-hm', 40, [adv('HIGH'), adv('MEDIUM')]);

    const text = slackBodyText();
    expect(text).toContain('pkg-HIGH');
    expect(text).not.toContain('pkg-MEDIUM');
    expect(text).toContain('CVEs gefunden:* 1');
  });

  it('Slack CRITICAL still lists the HIGH package of a CRITICAL+HIGH scan', async () => {
    webhookConfigFindMany.mockResolvedValue([]);
    slackConfigFindUnique.mockResolvedValue(slackConfig('CRITICAL'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-ch', 80, [adv('CRITICAL'), adv('HIGH')]);

    const text = slackBodyText();
    expect(text).toContain('pkg-CRITICAL');
    expect(text).toContain('pkg-HIGH');
    expect(text).toContain('CVEs gefunden:* 2');
  });

  it('Slack MEDIUM lists the most severe advisory first even when it arrives last', async () => {
    webhookConfigFindMany.mockResolvedValue([]);
    slackConfigFindUnique.mockResolvedValue(slackConfig('MEDIUM'));
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    await notifyForScan('user-1', 'repo-1', 'acme/web', 'scan-mix', 70, [
      adv('MEDIUM', 1),
      adv('HIGH', 1),
      adv('MEDIUM', 2),
      adv('MEDIUM', 3),
      adv('CRITICAL', 1),
    ]);

    const text = slackBodyText();
    expect(text).toContain('CVEs gefunden:* 5');
    expect(text).toContain('Mittel:* 3');
    // The top-3 list holds CRITICAL, then HIGH, then a MEDIUM.
    const list = text.slice(text.indexOf('Neue Schwachstellen'));
    expect(list.indexOf('pkg-CRITICAL')).toBeGreaterThan(-1);
    expect(list.indexOf('pkg-CRITICAL')).toBeLessThan(list.indexOf('pkg-HIGH'));
    expect(list.indexOf('pkg-HIGH')).toBeLessThan(list.indexOf('pkg-MEDIUM'));
  });
});
