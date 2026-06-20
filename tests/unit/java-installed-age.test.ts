import { describe, it, expect } from 'vitest';
import { resolveInstalledAge } from '@/lib/deps/java';

const FIXED_NOW = new Date('2025-01-01T00:00:00.000Z');

describe('resolveInstalledAge', () => {
  it('returns publishedAt and correct ageInDays from a GAV doc with a timestamp', () => {
    // 365 days before FIXED_NOW
    const installedTs = new Date('2024-01-01T00:00:00.000Z').getTime();
    const result = resolveInstalledAge({ timestamp: installedTs }, FIXED_NOW);
    expect(result.publishedAt).toEqual(new Date(installedTs));
    expect(result.ageInDays).toBe(366); // 2024 is a leap year (366 days)
  });

  it('uses the GAV (installed) timestamp, not a separate latest timestamp', () => {
    // Simulate installed version published 100 days ago, latest 10 days ago
    const installedTs = new Date('2024-09-23T00:00:00.000Z').getTime(); // 100 days before 2025-01-01
    // latest version would be only 10 days old — helper must use installedTs, not this
    const latestAgeInDays = 10;

    const result = resolveInstalledAge({ timestamp: installedTs }, FIXED_NOW);
    expect(result.ageInDays).toBe(100);
    // Confirm it does NOT match the latest timestamp age
    expect(result.ageInDays).not.toBe(latestAgeInDays);
  });

  it('returns publishedAt=null and ageInDays=-1 when gavDoc is undefined', () => {
    const result = resolveInstalledAge(undefined, FIXED_NOW);
    expect(result.publishedAt).toBeNull();
    expect(result.ageInDays).toBe(-1);
  });

  it('returns publishedAt=null and ageInDays=-1 when gavDoc has no timestamp (missing field)', () => {
    const result = resolveInstalledAge({} as { timestamp?: number }, FIXED_NOW);
    expect(result.publishedAt).toBeNull();
    expect(result.ageInDays).toBe(-1);
  });

  it('returns publishedAt=null and ageInDays=-1 when timestamp is 0 (falsy)', () => {
    // timestamp=0 is epoch — treated as falsy by `if (gavDoc?.timestamp)`, so we get -1.
    // This matches the guard intent: a missing/zero timestamp is unusable.
    const result = resolveInstalledAge({ timestamp: 0 }, FIXED_NOW);
    expect(result.publishedAt).toBeNull();
    expect(result.ageInDays).toBe(-1);
  });
});
