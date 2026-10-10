// Unit tests for lib/pr/webhook-secret.ts: generation and AES-256-GCM sealing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateWebhookSecret,
  getWebhookSecretKey,
  openWebhookSecret,
  sealWebhookSecret,
} from '@/lib/pr/webhook-secret';

describe('webhook secret sealing', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = 'nextauth-secret-for-tests';
    delete process.env.WEBHOOK_SECRET_KEY;
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.WEBHOOK_SECRET_KEY;
  });

  it('generates 64 hex characters from a random source', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('round-trips a secret for the row it was sealed for', () => {
    const sealed = sealWebhookSecret('plain-secret', 'row-1');
    expect(openWebhookSecret(sealed, 'row-1')).toBe('plain-secret');
  });

  it('does not store the plaintext', () => {
    const sealed = sealWebhookSecret('plain-secret-value', 'row-1');
    expect(sealed).not.toContain('plain-secret-value');
    expect(sealed).not.toContain(Buffer.from('plain-secret-value').toString('base64url'));
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('uses a fresh IV: sealing twice gives different values', () => {
    expect(sealWebhookSecret('s', 'row-1')).not.toBe(sealWebhookSecret('s', 'row-1'));
  });

  it('does not open for another row id (additional authenticated data)', () => {
    const sealed = sealWebhookSecret('plain-secret', 'row-1');
    expect(openWebhookSecret(sealed, 'row-2')).toBeNull();
  });

  it('does not open a tampered ciphertext or tag', () => {
    const [v, iv, tag, ct] = sealWebhookSecret('plain-secret', 'row-1').split('.');
    const flip = (part: string) => (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    expect(openWebhookSecret([v, iv, tag, flip(ct)].join('.'), 'row-1')).toBeNull();
    expect(openWebhookSecret([v, iv, flip(tag), ct].join('.'), 'row-1')).toBeNull();
    expect(openWebhookSecret([v, flip(iv), tag, ct].join('.'), 'row-1')).toBeNull();
  });

  it.each(['', 'garbage', 'v1.a.b', 'v2.a.b.c', 'v1...', 'v1.AAAA.BBBB.CCCC'])(
    'returns null, not an exception, for the malformed value %j',
    (value) => {
      expect(openWebhookSecret(value, 'row-1')).toBeNull();
    },
  );

  it('does not open after the key material changed', () => {
    const sealed = sealWebhookSecret('plain-secret', 'row-1');
    process.env.NEXTAUTH_SECRET = 'a different secret';
    expect(openWebhookSecret(sealed, 'row-1')).toBeNull();
  });

  it('prefers WEBHOOK_SECRET_KEY over NEXTAUTH_SECRET', () => {
    process.env.WEBHOOK_SECRET_KEY = 'dedicated-key';
    const sealed = sealWebhookSecret('plain-secret', 'row-1');
    process.env.NEXTAUTH_SECRET = 'rotated-session-secret';
    expect(openWebhookSecret(sealed, 'row-1')).toBe('plain-secret');
    delete process.env.WEBHOOK_SECRET_KEY;
    expect(openWebhookSecret(sealed, 'row-1')).toBeNull();
  });

  it('has no key, and neither seals nor opens, when no key material is set', () => {
    const sealed = sealWebhookSecret('plain-secret', 'row-1');
    delete process.env.NEXTAUTH_SECRET;
    expect(getWebhookSecretKey()).toBeNull();
    expect(() => sealWebhookSecret('x', 'row-1')).toThrow();
    expect(openWebhookSecret(sealed, 'row-1')).toBeNull();
  });

  it('treats blank key material as unset', () => {
    process.env.WEBHOOK_SECRET_KEY = '  ';
    process.env.NEXTAUTH_SECRET = '';
    expect(getWebhookSecretKey()).toBeNull();
  });

  it('derives a 32-byte key', () => {
    expect(getWebhookSecretKey()?.length).toBe(32);
  });

  // Known-answer fixture: key material, derived key and one sealed value fixed
  // here. A change to the key derivation (salt, info, hash) or to the stored
  // format or the bound row id makes every secret already stored unreadable, so
  // it must fail this test instead of passing a round trip with itself.
  describe('known answer', () => {
    const KEY_MATERIAL = 'known-answer-key-material';
    const DERIVED_KEY_HEX = '52ab939b8d8a8d53c84855610158c7b920468f76466ee694c61fab43f953d50b';
    const SEALED =
      'v1.mgW8_xllz1-hxYLl.oJeiaYEPz63JokkV1DRrzA.Ydi019DNQMR2vTVsdpDtvnxGRVlim-vi1jBV7_-V1F9Dhy9ld5pj';
    const PLAINTEXT = 'known-answer-plaintext-0123456789abcdef';

    beforeEach(() => {
      delete process.env.NEXTAUTH_SECRET;
      process.env.WEBHOOK_SECRET_KEY = KEY_MATERIAL;
    });

    it('derives the fixed key from the fixed key material', () => {
      expect(getWebhookSecretKey()?.toString('hex')).toBe(DERIVED_KEY_HEX);
    });

    it('opens the checked-in sealed value to the known plaintext for its row', () => {
      expect(openWebhookSecret(SEALED, 'row-known')).toBe(PLAINTEXT);
    });

    it('does not open the checked-in sealed value for another row', () => {
      expect(openWebhookSecret(SEALED, 'row-other')).toBeNull();
    });

    it('derives the same key from NEXTAUTH_SECRET when WEBHOOK_SECRET_KEY is unset', () => {
      delete process.env.WEBHOOK_SECRET_KEY;
      process.env.NEXTAUTH_SECRET = KEY_MATERIAL;
      expect(getWebhookSecretKey()?.toString('hex')).toBe(DERIVED_KEY_HEX);
      expect(openWebhookSecret(SEALED, 'row-known')).toBe(PLAINTEXT);
    });
  });
});
