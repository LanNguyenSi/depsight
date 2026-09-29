// runPostScanHooks hands the scan's degraded reason to the scan.completed
// notification unchanged, and defaults it to null for a healthy scan.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { evaluatePoliciesMock, notifyScanCompletedMock } = vi.hoisted(() => ({
  evaluatePoliciesMock: vi.fn(),
  notifyScanCompletedMock: vi.fn(),
}));

vi.mock('@/lib/policy/engine', () => ({ evaluatePolicies: evaluatePoliciesMock }));
vi.mock('@/lib/alerts/notifier', () => ({ notifyScanCompleted: notifyScanCompletedMock }));

import { runPostScanHooks } from '@/lib/alerts/post-scan';

describe('runPostScanHooks', () => {
  beforeEach(() => {
    evaluatePoliciesMock.mockReset().mockResolvedValue([]);
    notifyScanCompletedMock.mockReset().mockResolvedValue(undefined);
  });

  it('passes the degraded reason to the scan.completed notification', async () => {
    await runPostScanHooks('u1', 'r1', 'acme/web', 's1', 'cve', { cveCount: 0 }, 'OSV: HTTP 500: down');

    expect(notifyScanCompletedMock).toHaveBeenCalledTimes(1);
    expect(notifyScanCompletedMock.mock.calls[0][7]).toBe('OSV: HTTP 500: down');
  });

  it('passes null when the caller gives no reason', async () => {
    await runPostScanHooks('u1', 'r1', 'acme/web', 's1', 'cve', { cveCount: 0 });

    expect(notifyScanCompletedMock.mock.calls[0][7]).toBeNull();
  });
});
