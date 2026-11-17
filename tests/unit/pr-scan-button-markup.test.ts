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
    // The hook is on only while the dialog is rendered; `open: false` would disable it.
    expect(source).toContain('open: open && mounted,');
    expect(source).toContain('fallbackFocusRef,');
  });

  // Same limits as above for the hook: it runs only in a browser, so pin
  // that it calls the shared decision functions (their branches are tested
  // in dialog-focus.test.ts) and the listener and overflow plumbing.
  it('the shared hook delegates to the decision functions and keeps the listener plumbing', () => {
    const hook = readFileSync(resolve(__dirname, '../../components/useDialogFocus.ts'), 'utf8');
    expect(hook).toContain('handleDialogKey(e, {');
    expect(hook).toContain('onEscape: () => onEscapeRef.current()');
    expect(hook).toContain('lockScroll ? lockBodyScroll(document.body.style) : null');
    expect(hook).toContain('restoreScroll?.()');
    expect(hook).toContain('returnFocusTarget(opener, previouslyFocused, fallback)');
    expect(hook).toContain('const fallback = fallbackFocusRef?.current ?? null;');
    expect(hook).toContain('active: document.activeElement,');
    expect(hook).toContain("window.addEventListener('keydown', onKeyDown, true)");
    expect(hook).toContain("window.removeEventListener('keydown', onKeyDown, true)");
  });

  it('the dashboard hands the actions menu button to the dialog as the fallback focus target', () => {
    const src = readFileSync(resolve(__dirname, '../../app/dashboard/DashboardClient.tsx'), 'utf8');
    expect(src).toContain('menuItem fallbackFocusRef={actionsButtonRef}');
  });
});
