import { describe, it, expect } from 'vitest';
import { SEVERITY_RANK, severityGte, severityValue } from '@/lib/severity';

describe('shared severity ranking', () => {
  it('orders CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN', () => {
    expect(SEVERITY_RANK.CRITICAL).toBeGreaterThan(SEVERITY_RANK.HIGH);
    expect(SEVERITY_RANK.HIGH).toBeGreaterThan(SEVERITY_RANK.MEDIUM);
    expect(SEVERITY_RANK.MEDIUM).toBeGreaterThan(SEVERITY_RANK.LOW);
    expect(SEVERITY_RANK.LOW).toBeGreaterThan(SEVERITY_RANK.UNKNOWN);
  });

  it('severityGte compares every adjacent pair in both directions', () => {
    const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(severityGte(order[i], order[j])).toBe(i <= j);
      }
    }
  });

  it('ranks an unrecognised severity like UNKNOWN', () => {
    expect(severityValue('BOGUS')).toBe(SEVERITY_RANK.UNKNOWN);
    expect(severityValue('constructor')).toBe(SEVERITY_RANK.UNKNOWN);
    expect(severityGte('BOGUS', 'LOW')).toBe(false);
    expect(severityGte('LOW', 'BOGUS')).toBe(true);
  });
});
