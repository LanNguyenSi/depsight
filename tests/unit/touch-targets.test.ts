// WCAG 2.5.8: interactive elements are at least 24x24 CSS px. `min-h-6` is the
// 24 px floor (Tailwind spacing 6 = 1.5rem); the controls below were 16-23 px
// before. Rendered markup is checked where a component renders on its own;
// the dashboard shell needs its whole data layer, so its source is read.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { AdvisoryList } from '@/components/AdvisoryList';
import { DependencyTable } from '@/components/DependencyTable';
import { PolicyList } from '@/components/PolicyList';
import { ForkScanSelect } from '@/components/settings/ForkScanSelect';
import { SecretRowActions } from '@/components/settings/SecretRowActions';
import { SettingsClient } from '@/app/settings/SettingsClient';

vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}));

const ROOT = resolve(__dirname, '../..');

function withLocale(el: React.ReactElement): string {
  return renderToStaticMarkup(createElement(LocaleProvider, null, el));
}

/** Opening tags of every element named `tag` whose content starts with `text`. */
function tagsWith(html: string, tag: string, text: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>(?=${text})`, 'g'))].map((m) => m[0]);
}

describe('advisory list touch targets', () => {
  const advisory = {
    id: 'a1',
    ghsaId: 'GHSA-aaaa-bbbb-cccc',
    cveId: null,
    source: 'osv' as const,
    severity: 'HIGH' as const,
    summary: 'Prototype pollution',
    packageName: 'lodash',
    ecosystem: 'npm',
    vulnerableRange: '<4.17.21',
    fixedVersion: '4.17.21',
    publishedAt: null,
    url: 'https://example.test/advisory',
    state: null,
  };
  const html = withLocale(createElement(AdvisoryList, { advisories: [advisory], repoId: 'repo-1' }));

  it('gives the confirm and ignore buttons a 24 px floor', () => {
    expect(tagsWith(html, 'button', 'Bestätigen')).toHaveLength(1);
    expect(tagsWith(html, 'button', 'Ignorieren')).toHaveLength(1);
    for (const tag of [...tagsWith(html, 'button', 'Bestätigen'), ...tagsWith(html, 'button', 'Ignorieren')]) {
      expect(tag).toContain('min-h-6');
      expect(tag).toContain('items-center');
    }
  });

  it('gives the details link a 24 px floor', () => {
    const tags = tagsWith(html, 'a', 'Details');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('min-h-6');
  });

  it('gives every severity chip and the ignored-toggle a 24 px floor', () => {
    for (const label of ['Kritisch', 'Hoch', 'Mittel', 'Niedrig', 'Ignorierte ausblenden']) {
      const tags = tagsWith(html, 'button', label);
      expect(tags, label).toHaveLength(1);
      expect(tags[0], label).toContain('min-h-6');
    }
  });

  it('mutes an inactive chip by colour, not by opacity', () => {
    // the ignored-toggle starts switched off
    const tag = tagsWith(html, 'button', 'Ignorierte ausblenden')[0];
    expect(tag).toContain('text-gray-400');
    expect(tag).not.toContain('opacity-');
  });
});

describe('dependency table touch targets', () => {
  it('gives the status chips a 24 px floor', () => {
    const html = withLocale(
      createElement(DependencyTable, {
        dependencies: [
          { name: 'a', currentVersion: '1.0.0', latestVersion: '1.0.0', status: 'UP_TO_DATE', ageDays: 1, ecosystem: 'npm', scope: 'runtime' },
        ] as never,
        summary: { total: 1, upToDate: 1, outdated: 0, majorBehind: 0, deprecated: 0, unknown: 0 } as never,
      }),
    );
    const chips = [...html.matchAll(/<button\b[^>]*text-\[10px\][^>]*>/g)].map((m) => m[0]);
    expect(chips).toHaveLength(5);
    for (const tag of chips) expect(tag).toContain('min-h-6');
  });
});

describe('policy list touch targets', () => {
  const policy = {
    id: 'p1',
    name: 'No GPL',
    type: 'LICENSE_DENY' as const,
    severity: 'HIGH' as const,
    rule: { deniedLicenses: ['GPL-3.0'] },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const html = withLocale(
    createElement(PolicyList, {
      initialPolicies: [
        { ...policy, enabled: true },
        { ...policy, id: 'p2', name: 'Draft', enabled: false },
      ],
    }),
  );

  it('sizes the switch to 24 px high and keeps the knob inside the track', () => {
    const tags = [...html.matchAll(/<button\b[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(2);
    for (const tag of tags) {
      expect(tag).toContain('h-6');
      expect(tag).toContain('w-10');
    }
    // knob: 16 px, 4 px from either end of the 40 px track
    expect(html).toContain('h-4 w-4 transform rounded-full bg-white transition-transform translate-x-5');
    expect(html).toContain('h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1');
  });

  it('gives the delete buttons a 24 px floor', () => {
    const tags = tagsWith(html, 'button', 'Löschen');
    expect(tags).toHaveLength(2);
    for (const tag of tags) expect(tag).toContain('min-h-6');
  });

  it('marks a disabled policy by a dashed border and a muted name, not by opacity', () => {
    expect(html).toContain('border-gray-800/50 border-dashed');
    expect(html).not.toMatch(/border-dashed[^"]*opacity-/);
    expect(html).toContain('font-medium text-sm truncate text-gray-400">Draft<');
    expect(html).toContain('font-medium text-sm truncate text-gray-200">No GPL<');
  });
});

describe('settings touch targets', () => {
  const labels = {
    generate: 'Generate',
    rotate: 'Rotate',
    remove: 'Remove',
    working: 'Working',
    unavailable: 'unavailable',
  };
  const actions = (configured: boolean) =>
    renderToStaticMarkup(
      createElement(SecretRowActions, {
        configured,
        available: true,
        busy: false,
        labels,
        onGenerate: () => undefined,
        onRotate: () => undefined,
        onRemove: () => undefined,
      }),
    );

  it('gives the secret row buttons a 24 px floor', () => {
    for (const [html, label] of [
      [actions(false), 'Generate'],
      [actions(true), 'Rotate'],
      [actions(true), 'Remove'],
    ] as const) {
      const tags = tagsWith(html, 'button', label);
      expect(tags, label).toHaveLength(1);
      expect(tags[0], label).toContain('min-h-6');
    }
  });

  it('keeps the fork select 24 px high and lets it shrink inside a narrow row', () => {
    const html = renderToStaticMarkup(
      createElement(ForkScanSelect, {
        row: { configured: true, private: true, scanForks: null },
        forksDefault: true,
        busy: false,
        labels: {
          title: 'Fork pull requests',
          defaultOn: 'Default (scan)',
          defaultOff: 'Default (ignore)',
          scan: 'Scan',
          ignore: 'Ignore',
          publicNote: '',
          noSecretNote: '',
        },
        onChange: () => undefined,
      }),
    );
    const select = html.match(/<select\b[^>]*>/)![0];
    expect(select).toContain('min-h-6');
    expect(select).toContain('min-w-0');
    expect(select).toContain('max-w-full');
    expect(html.match(/<label\b[^>]*>/)![0]).toContain('max-w-full');
  });

  it('wraps every checkbox in a 24 px label and sizes the box to 16 px', () => {
    const html = withLocale(createElement(SettingsClient));
    const boxes = [...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const tag of boxes) expect(tag).toContain('size-4');
    // each checkbox is the first child of a label that carries the floor
    const labelled = [...html.matchAll(/<label\b[^>]*>(?=<input\b[^>]*type="checkbox")/g)].map((m) => m[0]);
    expect(labelled).toHaveLength(boxes.length);
    for (const tag of labelled) expect(tag).toContain('min-h-6');
  });
});

describe('dashboard controls', () => {
  const src = readFileSync(resolve(ROOT, 'app/dashboard/DashboardClient.tsx'), 'utf8');

  it('gives the sort buttons, scan-all, sync and the mobile back button a 24 px floor', () => {
    expect(src).toContain('className={`min-h-6 px-2 text-[10px] rounded transition-colors ${');
    expect(src).toContain('inline-flex items-center min-h-6 px-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50');
    expect(src).toContain('inline-flex items-center min-h-6 px-1 text-xs text-gray-400 hover:text-gray-300 disabled:opacity-50');
    expect(src).toContain('inline-flex items-center min-h-6 px-1 text-xs text-red-400 hover:text-red-300');
    expect(src).toContain('md:hidden flex items-center gap-1 min-h-6 text-xs');
  });
});
