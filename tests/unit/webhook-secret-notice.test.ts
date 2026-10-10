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
  it('is editable only for a private repository with a configured secret', () => {
    expect(forkControlState({ configured: true, private: true })).toBe('editable');
  });

  it('says the opt-in is ignored for a public repository with a secret', () => {
    expect(forkControlState({ configured: true, private: false })).toBe('publicIgnored');
  });

  it('says the setting has no effect without a secret, public or private', () => {
    expect(forkControlState({ configured: false, private: true })).toBe('noSecret');
    expect(forkControlState({ configured: false, private: false })).toBe('noSecret');
  });
});
