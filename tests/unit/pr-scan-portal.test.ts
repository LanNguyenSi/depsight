// The PR-scan trigger renders as a row of the dashboard actions menu
// (role="menu"). Its modal is portaled to document.body (after mount, so
// server and first client render match): rendered inline it would be a child
// of the menu and break aria-required-children. The portal wiring itself is
// client-only, so this test pins the closed-state markup and the portal
// contract in the source; the live portal target and the axe result on
// /dashboard are proven in the browser check.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '@/lib/i18n';
import { PRScanButton } from '@/components/PRScanButton';

const SOURCE = readFileSync(resolve(__dirname, '../../components/PRScanButton.tsx'), 'utf8');

function render(menuItem: boolean): string {
  return renderToStaticMarkup(
    createElement(
      LocaleProvider,
      { initialLocale: 'de' },
      createElement(PRScanButton, { owner: 'acme', repo: 'api', menuItem }),
    ),
  );
}

describe('PRScanButton portal to document.body', () => {
  it('renders the closed trigger as a menuitem when used as a menu row', () => {
    expect(render(true)).toContain('<button role="menuitem"');
    expect(render(false)).not.toContain('role="menuitem"');
  });

  it('does not render the modal before it is opened', () => {
    expect(render(true)).not.toContain('PR CVE Scan');
  });

  it('portals the modal to document.body instead of nesting it in the menu', () => {
    expect(SOURCE).toContain("import { createPortal } from 'react-dom'");
    expect(SOURCE).toMatch(/createPortal\(\s*<div/);
    expect(SOURCE).toMatch(/,\s*document\.body,\s*\)/);
  });

  it('renders the portal only on the client (SSR guard)', () => {
    expect(SOURCE).toMatch(/const \[mounted\] = useState\(\(\) => typeof window !== 'undefined'\);/);
    expect(SOURCE).toMatch(/open &&\s*mounted &&\s*createPortal/);
  });

  it('keeps closing through the cancel button and the overlay click', () => {
    expect(SOURCE).toMatch(/onClick=\{\(\) => setOpen\(false\)\}/);
    expect(SOURCE).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it('marks the portaled modal as a labelled dialog, so it is not off-landmark content', () => {
    expect(SOURCE).toContain('role="dialog"');
    expect(SOURCE).toContain('aria-modal="true"');
    expect(SOURCE).toContain('aria-labelledby="pr-scan-modal-title"');
    expect(SOURCE).toMatch(/<h3 id="pr-scan-modal-title"/);
  });

  it('exempts the portaled modal from the menu dismiss-on-outside-mousedown', () => {
    // The overlay carries the marker, and the actions menu's dismiss handler
    // skips mousedown inside it: unmounted with the menu, the modal would die
    // on the first click into its input.
    expect(SOURCE).toContain('data-pr-scan-portal');
    const menu = readFileSync(resolve(__dirname, '../../app/dashboard/DashboardClient.tsx'), 'utf8');
    expect(menu).toMatch(/closest\?\.\('\[data-pr-scan-portal\]'\)/);
  });
});
