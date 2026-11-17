// The comparison table is wider than a phone: its scroll container must be a
// named, keyboard-focusable region, and a below-sm hint must point at the
// columns that are off screen.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '@/lib/i18n';
import { RepoComparisonTable } from '@/components/overview/RepoComparisonTable';

function render(locale: 'de' | 'en'): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { initialLocale: locale }, createElement(RepoComparisonTable, { repos: [] })),
  );
}

function scrollContainerTag(html: string): string {
  const m = html.match(/<div[^>]*overflow-x-auto[^>]*>/);
  if (!m) throw new Error(`no overflow-x-auto container in ${html}`);
  return m[0];
}

describe('RepoComparisonTable scroll region', () => {
  it('names the scroll container as a keyboard-focusable region in German', () => {
    const tag = scrollContainerTag(render('de'));
    expect(tag).toContain('role="region"');
    expect(tag).toContain('aria-label="Repository Vergleich, seitlich scrollbar"');
    expect(tag).toContain('tabindex="0"');
  });

  it('names the scroll container as a keyboard-focusable region in English', () => {
    const tag = scrollContainerTag(render('en'));
    expect(tag).toContain('role="region"');
    expect(tag).toContain('aria-label="Repository comparison, scrollable to the right"');
    expect(tag).toContain('tabindex="0"');
  });

  it('shows a more-columns hint that is hidden from the sm breakpoint up', () => {
    const de = render('de');
    expect(de).toContain('<p class="px-4 py-2 text-xs text-gray-500 sm:hidden">Mehr Spalten durch seitliches Scrollen.</p>');
    const en = render('en');
    expect(en).toContain('<p class="px-4 py-2 text-xs text-gray-500 sm:hidden">Scroll right to see more columns.</p>');
  });
});
