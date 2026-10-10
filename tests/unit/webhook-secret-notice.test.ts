import { describe, it, expect } from 'vitest';
import { showRotateHint } from '@/lib/pr/webhook-secret-notice';

describe('showRotateHint', () => {
  it('hints rotation only for a configured, unusable secret while key material is available', () => {
    expect(showRotateHint(true, { configured: true, usable: false })).toBe(true);
    expect(showRotateHint(true, { configured: true, usable: true })).toBe(false);
    expect(showRotateHint(true, { configured: false, usable: false })).toBe(false);
  });

  it('shows no per-row hint when key material is unavailable, whatever the row says', () => {
    expect(showRotateHint(false, { configured: true, usable: false })).toBe(false);
    expect(showRotateHint(false, { configured: true, usable: true })).toBe(false);
    expect(showRotateHint(false, { configured: false, usable: false })).toBe(false);
  });
});
