import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { PRScanButton } from '@/components/PRScanButton';

describe('PRScanButton', () => {
  it('renders the trigger as a menuitem inside a menu and no dialog while closed', () => {
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, { initialLocale: 'en' }, createElement(PRScanButton, { owner: 'o', repo: 'r', menuItem: true })),
    );
    expect(html).toContain('role="menuitem"');
    expect(html).not.toContain('role="dialog"');
  });

  it('renders a plain button outside a menu', () => {
    const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: 'en' }, createElement(PRScanButton, { owner: 'o', repo: 'r' })));
    expect(html).not.toContain('role=');
  });

  // The hook runs only in a browser (no jsdom here); pin that the dialog is
  // wired to it with scroll lock and a named return target, so the wiring
  // cannot be dropped silently. The behaviour itself is checked in the browser.
  it('wires the dialog to the shared focus hook with scroll lock and the trigger as return target', () => {
    const source = readFileSync(resolve(__dirname, '../../components/PRScanButton.tsx'), 'utf8');
    expect(source).toContain('useDialogFocus({');
    expect(source).toContain('lockScroll: true');
    expect(source).toContain('returnFocusRef: triggerRef');
    expect(source).toContain('initialFocus: () => inputRef.current');
  });

  // Same limits as above for the hook: the Escape and scroll-lock branches
  // only run in a browser, so pin the calls that implement them.
  it('the shared hook consumes Escape in the capture phase and restores the previous overflow', () => {
    const hook = readFileSync(resolve(__dirname, '../../components/useDialogFocus.ts'), 'utf8');
    expect(hook).toContain('e.stopPropagation()');
    expect(hook).toContain("window.addEventListener('keydown', onKeyDown, true)");
    expect(hook).toContain("window.removeEventListener('keydown', onKeyDown, true)");
    expect(hook).toContain('document.body.style.overflow = previousOverflow');
    expect(hook).toContain('const previousOverflow = document.body.style.overflow');
  });
});
