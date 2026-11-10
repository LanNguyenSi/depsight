import { describe, it, expect } from 'vitest';
import { API_TOKEN_PREFIX, generateApiToken, hashApiToken } from '@/lib/api-token';

describe('hashApiToken', () => {
  it('is the lowercase hex SHA-256 of the UTF-8 token (known vectors)', () => {
    expect(hashApiToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashApiToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is deterministic, distinguishes inputs and never starts with the dsat_ prefix', () => {
    const a = 'dsat_' + 'a'.repeat(64);
    const b = 'dsat_' + 'b'.repeat(64);
    expect(hashApiToken(a)).toBe(hashApiToken(a));
    expect(hashApiToken(a)).not.toBe(hashApiToken(b));
    expect(hashApiToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiToken(a).startsWith(API_TOKEN_PREFIX)).toBe(false);
  });
});

describe('generateApiToken', () => {
  it('is dsat_ plus 64 hex characters and differs on every call', () => {
    const first = generateApiToken();
    expect(first).toMatch(/^dsat_[0-9a-f]{64}$/);
    expect(generateApiToken()).not.toBe(first);
  });
});
