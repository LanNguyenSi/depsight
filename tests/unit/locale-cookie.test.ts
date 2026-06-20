import { describe, it, expect } from 'vitest';
import { parseLocaleCookie, DEFAULT_LOCALE } from '@/lib/i18n/translations';

describe('parseLocaleCookie', () => {
  it('returns "en" for locale=en', () => {
    expect(parseLocaleCookie('locale=en')).toBe('en');
  });

  it('returns "de" for locale=de', () => {
    expect(parseLocaleCookie('locale=de')).toBe('de');
  });

  it('returns DEFAULT_LOCALE for an empty string', () => {
    expect(parseLocaleCookie('')).toBe(DEFAULT_LOCALE);
  });

  it('returns DEFAULT_LOCALE for undefined', () => {
    expect(parseLocaleCookie(undefined)).toBe(DEFAULT_LOCALE);
  });

  it('returns DEFAULT_LOCALE for the old buggy NEXT_LOCALE cookie name', () => {
    expect(parseLocaleCookie('NEXT_LOCALE=en')).toBe(DEFAULT_LOCALE);
  });

  it('parses locale= when preceded by other cookies', () => {
    expect(parseLocaleCookie('foo=bar; locale=en')).toBe('en');
  });

  it('returns DEFAULT_LOCALE for an unrecognised locale value', () => {
    expect(parseLocaleCookie('locale=fr')).toBe(DEFAULT_LOCALE);
  });
});
