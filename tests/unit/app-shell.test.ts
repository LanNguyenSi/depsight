import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/overview',
}));

vi.mock('@/app/actions', () => ({
  logout: () => undefined,
}));

import { AppShell } from '@/components/AppShell';
import { LocaleProvider } from '@/lib/i18n';

function render(): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { initialLocale: 'de' },
      createElement(AppShell, {}, createElement('span', null, 'content'))),
  );
}

function menuButtonTag(html: string): string {
  const match = html.match(/<button[^>]*aria-controls="mobile-nav"[^>]*>/);
  if (!match) throw new Error('no mobile nav menu button in rendered markup');
  return match[0];
}

describe('AppShell mobile nav button', () => {
  it('is a collapsed disclosure while the mobile nav is closed', () => {
    const tag = menuButtonTag(render());
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('aria-controls="mobile-nav"');
  });
});

describe('AppShell user menu trigger', () => {
  it('is a menu button the keyboard handlers can find', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  });
});
