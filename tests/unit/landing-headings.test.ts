// The logged-out landing page must have a continuous heading order:
// h1, then an h2 before the feature cards, then h3 for each card.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const locale = vi.hoisted(() => ({ value: 'de' }));
vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: locale.value }) }),
}));

import HomePage from '@/app/page';

async function headingLevels(): Promise<string[]> {
  const html = renderToStaticMarkup(await HomePage());
  return [...html.matchAll(/<h([1-6])\b/g)].map((m) => `h${m[1]}`);
}

describe('landing page heading order', () => {
  beforeEach(() => {
    locale.value = 'de';
  });

  it('is h1, h2, then six h3 cards in German', async () => {
    expect(await headingLevels()).toEqual(['h1', 'h2', 'h3', 'h3', 'h3', 'h3', 'h3', 'h3']);
  });

  it('is the same in English and the h2 is visually hidden and named', async () => {
    locale.value = 'en';
    const html = renderToStaticMarkup(await HomePage());
    expect(await headingLevels()).toEqual(['h1', 'h2', 'h3', 'h3', 'h3', 'h3', 'h3', 'h3']);
    expect(html).toContain('<h2 class="sr-only">Features</h2>');
  });

  it('names the German h2 Funktionen', async () => {
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain('<h2 class="sr-only">Funktionen</h2>');
  });
});
