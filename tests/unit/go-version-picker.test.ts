import { describe, it, expect } from 'vitest';
import { pickLatestGoVersion } from '@/lib/deps/go';

describe('pickLatestGoVersion', () => {
  it('returns empty string for empty input', () => {
    expect(pickLatestGoVersion([])).toBe('');
  });

  it('returns the single entry when only one version is present', () => {
    expect(pickLatestGoVersion(['v1.2.3'])).toBe('v1.2.3');
  });

  it('picks the highest stable version from an unsorted list', () => {
    const versions = ['v1.3.0', 'v1.10.0', 'v1.2.0', 'v1.9.1'];
    expect(pickLatestGoVersion(versions)).toBe('v1.10.0');
  });

  it('ignores pseudo-versions (pre-release containing -) when stable versions exist', () => {
    const versions = [
      'v0.0.0-20210101120000-abcdef012345', // pseudo-version
      'v1.2.3',
      'v1.4.0',
      'v1.3.0-alpha.1',                     // pre-release
    ];
    expect(pickLatestGoVersion(versions)).toBe('v1.4.0');
  });

  it('ignores +incompatible suffixes when stable versions exist', () => {
    const versions = ['v1.2.0', 'v2.0.0+incompatible', 'v1.5.0'];
    expect(pickLatestGoVersion(versions)).toBe('v1.5.0');
  });

  it('falls back to the last element when all versions are pseudo/pre-release', () => {
    const versions = [
      'v0.0.0-20210101120000-aaa111bbb222',
      'v0.0.0-20220202130000-ccc333ddd444',
    ];
    expect(pickLatestGoVersion(versions)).toBe('v0.0.0-20220202130000-ccc333ddd444');
  });

  it('handles a mix of stable and incompatible, picks max stable', () => {
    const versions = [
      'v3.0.0+incompatible',
      'v1.0.0',
      'v1.1.0',
      'v0.0.0-20190901000000-abcdef123456',
    ];
    expect(pickLatestGoVersion(versions)).toBe('v1.1.0');
  });

  it('returns the single stable version even when pseudo-versions appear before it', () => {
    const versions = [
      'v0.0.0-20200101000000-deadbeef1234',
      'v1.0.0',
    ];
    expect(pickLatestGoVersion(versions)).toBe('v1.0.0');
  });
});
