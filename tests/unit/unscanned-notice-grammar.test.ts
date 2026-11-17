// The unscanned hint must read correctly for one repo and for many, in both
// languages: it must not carry a plural verb tied to a fixed count.
import { describe, expect, it } from 'vitest';
import { getTranslations, interpolate } from '@/lib/i18n';

function notice(locale: 'de' | 'en', count: number, total: number): string {
  return interpolate(getTranslations(locale)['overview.unscannedNotice'], { count, total });
}

describe('overview.unscannedNotice', () => {
  it('reads correctly in German for one repo', () => {
    expect(notice('de', 1, 3)).toBe('Noch nicht gescannt: 1 von 3 Repos.');
  });

  it('reads correctly in German for several repos', () => {
    expect(notice('de', 3, 3)).toBe('Noch nicht gescannt: 3 von 3 Repos.');
  });

  it('reads correctly in English for one repo', () => {
    expect(notice('en', 1, 3)).toBe('Not scanned yet: 1 of 3 repos.');
  });

  it('reads correctly in English for several repos', () => {
    expect(notice('en', 3, 3)).toBe('Not scanned yet: 3 of 3 repos.');
  });
});
