import { describe, it, expect, afterEach } from 'vitest';
import { scanForksDefault } from '@/lib/pr/scan-forks-default';

describe('scanForksDefault', () => {
  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SCAN_FORKS;
  });

  it('is false when the variable is unset', () => {
    delete process.env.GITHUB_WEBHOOK_SCAN_FORKS;
    expect(scanForksDefault()).toBe(false);
  });

  it.each(['true', 'TRUE', ' True ', '\ttrue\n'])('is true for %j', (value) => {
    process.env.GITHUB_WEBHOOK_SCAN_FORKS = value;
    expect(scanForksDefault()).toBe(true);
  });

  it.each(['', '1', 'yes', 'false', 'on', 'truee'])('is false for %j', (value) => {
    process.env.GITHUB_WEBHOOK_SCAN_FORKS = value;
    expect(scanForksDefault()).toBe(false);
  });
});
