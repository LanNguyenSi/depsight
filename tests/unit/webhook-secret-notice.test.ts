import { describe, it, expect } from 'vitest';
import { forkControlState, showRotateHint } from '@/lib/pr/webhook-secret-notice';

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

describe('forkControlState', () => {
  it('is fully editable for a private repository with a configured secret', () => {
    expect(forkControlState({ configured: true, private: true })).toEqual({
      selectDisabled: false,
      scanDisabled: false,
      note: 'none',
    });
  });

  it('keeps Ignore selectable but disables Scan for a public repository with a secret', () => {
    const state = forkControlState({ configured: true, private: false });
    expect(state.selectDisabled).toBe(false);
    expect(state.scanDisabled).toBe(true);
    expect(state.note).toBe('publicScanIgnored');
  });

  it('disables the whole control without a secret, public or private', () => {
    for (const isPrivate of [true, false]) {
      const state = forkControlState({ configured: false, private: isPrivate });
      expect(state.selectDisabled).toBe(true);
      expect(state.note).toBe('noSecret');
    }
  });
});
