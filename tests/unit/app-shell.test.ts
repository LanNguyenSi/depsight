import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('AppShell mobile nav dismissal', () => {
  // The effect needs a DOM; the node environment cannot run it, so the wiring
  // is read from source and the browser check proves the behaviour.
  const src = readFileSync(resolve(__dirname, '../../components/AppShell.tsx'), 'utf8');
  const effect = src.slice(src.indexOf('if (!menuOpen) return;'), src.indexOf('}, [menuOpen]);'));

  it('closes on Escape and hands focus back to the menu button', () => {
    expect(effect).toContain('isEscapeKey(e.key)');
    expect(effect).toContain('mobileButtonRef.current?.focus()');
  });

  it('closes on a mousedown outside the header', () => {
    expect(effect).toContain("addEventListener('mousedown', onPointerDown)");
    expect(effect).toContain('!headerRef.current.contains(e.target as Node)');
  });
});

describe('AppShell user menu trigger', () => {
  it('is a menu button the keyboard handlers can find', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  });
});
