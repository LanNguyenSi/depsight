// The compatible-licenses list and the dependency table are the two other
// scroll containers in the dashboard: like the comparison table they must be
// named, keyboard-focusable regions so a keyboard user can reach the content
// that is scrolled out of view.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '@/lib/i18n';
import { LicenseList } from '@/components/LicenseList';
import { DependencyTable } from '@/components/DependencyTable';

function renderLicenseList(locale: 'de' | 'en'): string {
  return renderToStaticMarkup(
    createElement(
      LocaleProvider,
      { initialLocale: locale },
      createElement(LicenseList, {
        licenses: [
          { id: 'l1', packageName: 'left-pad', version: '1.0.0', license: 'MIT', isCompatible: true, policyViolation: false },
        ],
        summary: { MIT: 1 },
        conflictCount: 0,
      }),
    ),
  );
}

function renderDependencyTable(locale: 'de' | 'en'): string {
  const summary = { total: 1, upToDate: 1, outdated: 0, majorBehind: 0, deprecated: 0, unknown: 0 };
  return renderToStaticMarkup(
    createElement(
      LocaleProvider,
      { initialLocale: locale },
      createElement(DependencyTable, {
        dependencies: [
          {
            id: 'd1',
            name: 'react',
            installedVersion: '19.0.0',
            latestVersion: '19.0.0',
            ageInDays: 10,
            status: 'UP_TO_DATE' as const,
            isDeprecated: false,
            updateAvailable: false,
          },
        ],
        summary,
      }),
    ),
  );
}

function openTagOf(html: string, classNeedle: string): string {
  const m = html.match(new RegExp(`<div[^>]*${classNeedle}[^>]*>`));
  if (!m) throw new Error(`no div with ${classNeedle} in ${html}`);
  return m[0];
}

function expectFocusableRegion(tag: string, label: string): void {
  expect(tag).toContain('role="region"');
  expect(tag).toContain(`aria-label="${label}"`);
  expect(tag).toContain('tabindex="0"');
}

describe('LicenseList compatible-list scroll region', () => {
  it('names the vertical scroll region in German', () => {
    expectFocusableRegion(openTagOf(renderLicenseList('de'), 'max-h-64 overflow-y-auto'), 'Kompatible Pakete, scrollbar');
  });

  it('names the vertical scroll region in English', () => {
    expectFocusableRegion(openTagOf(renderLicenseList('en'), 'max-h-64 overflow-y-auto'), 'Compatible packages, scrollable');
  });
});

describe('DependencyTable scroll region', () => {
  it('names the horizontal scroll region in German', () => {
    const tag = openTagOf(renderDependencyTable('de'), 'overflow-x-auto');
    expect(tag).toContain('bg-gray-900');
    expectFocusableRegion(tag, 'Abhängigkeiten, seitlich scrollbar');
  });

  it('names the horizontal scroll region in English', () => {
    expectFocusableRegion(openTagOf(renderDependencyTable('en'), 'overflow-x-auto'), 'Dependencies, scrollable to the right');
  });
});
