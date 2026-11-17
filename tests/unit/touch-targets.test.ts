// WCAG 2.5.8: interactive elements are at least 24x24 CSS px. `min-h-6` is the
// 24 px floor (Tailwind spacing 6 = 1.5rem); the controls below were 16-23 px
// before. Rendered markup is checked where a component renders on its own;
// the dashboard shell needs its whole data layer, so its source is read.
// The last describe block scans every interactive element in the sources.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { AdvisoryList } from '@/components/AdvisoryList';
import { DependencyTable } from '@/components/DependencyTable';
import { PolicyList } from '@/components/PolicyList';
import { PRScanButton } from '@/components/PRScanButton';
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
    const label = html.match(/<label\b[^>]*>/)![0];
    expect(label).toContain('max-w-full');
    // below sm the label text sits above the select instead of squeezing it
    expect(label).toContain('flex-col');
    expect(label).toContain('sm:flex-row');
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

describe('PR scan trigger inside the actions menu', () => {
  const render = (menuItem?: boolean) =>
    withLocale(createElement(PRScanButton, { owner: 'o', repo: 'r', ...(menuItem === undefined ? {} : { menuItem }) }));

  it('is a menuitem row with the sibling look when rendered for the menu', () => {
    const tag = render(true).match(/<button\b[^>]*>/)![0];
    expect(tag).toContain('role="menuitem"');
    expect(tag).toContain('w-full text-left px-4 py-2.5 text-sm');
  });

  it('keeps the plain button without a role for every other caller', () => {
    const tag = render().match(/<button\b[^>]*>/)![0];
    expect(tag).not.toContain('role=');
    expect(tag).toContain('px-3 py-1.5');
    expect(render(false).match(/<button\b[^>]*>/)![0]).not.toContain('role=');
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

  it('keeps the actions menu owning only menu items: the PR scan wrapper and the divider are presentational', () => {
    const menu = src.slice(src.indexOf('<div role="menu"'));
    expect(menu).toContain('<div role="none">\n                          <PRScanButton owner={selectedRepo.owner} repo={selectedRepo.name} menuItem fallbackFocusRef={actionsButtonRef} />');
    expect(menu).toContain('<div role="separator" className="border-t border-gray-800 my-1" />');
  });
});

// Generic scan: every <button>, <a>, <Link> and <select> in app/ and components/
// must give its className a 24 px floor, so a new or edited control cannot
// silently drop below WCAG 2.5.8. Parsing: for each opening tag the text up to
// its closing `>` is cut out (quote- and brace-aware, so `=>` and `>` inside
// props do not end it) and searched for a floor class token: min-h-6 or
// larger, h-6 or larger, size-6 or larger, or py-1.5 or larger (12 px of
// padding plus at least a 15 px line is 27 px). identifiers in `className={...}` are resolved
// to `const name = '...'` in the same file (a conditional counts as passing when
// any branch has the floor; the browser check covers the rest). Limits: it reads class text, not
// the browser (it cannot see a parent that stretches the element, or a class
// built from pieces at run time), only these four tags are checked (text inputs
// are 32 px high through py-1.5 and text-sm; the checkbox rule is the render
// test above), and an element is judged by its own tag, not by a wrapper.
// Elements that reach 24 px by content are named below with the reason.
const FLOOR =
  /(?<![\w:-])(?:min-h-(?:[6-9]|\d{2,})|h-(?:[6-9]|\d{2,})|size-(?:[6-9]|\d{2,})|py-(?:1\.5|[2-9]|\d{2,}|[2-9]\.5))(?![\w.-])/;
const SCANNED_TAG = /<(?:button|a|Link|select)(?![\w-])/g;

const FLOOR_ALLOWLIST = [
  {
    file: 'components/AppShell.tsx',
    contains: 'href="/overview"',
    reason: 'logo link: wraps a 28 px logo tile, measured 28 px high',
  },
  {
    file: 'components/AppShell.tsx',
    contains: "t['user.menu']",
    reason: 'user menu button: avatar plus py-1, measured 34 px high',
  },
  {
    file: 'components/AppShell.tsx',
    contains: "t['nav.menu']",
    reason: 'mobile menu button: p-1.5 around a 20 px icon, measured 32 px',
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Index of the `>` that closes the opening tag that starts before `from`. */
function tagEnd(src: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

/** Opening tags of the scanned elements: `file:line` and the tag text. */
function interactiveTags(): { where: string; file: string; text: string }[] {
  const out: { where: string; file: string; text: string }[] = [];
  const files = [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'components'))];
  for (const full of files) {
    const src = readFileSync(full, 'utf8');
    const file = relative(ROOT, full);
    for (const m of src.matchAll(SCANNED_TAG)) {
      const end = tagEnd(src, m.index! + m[0].length);
      let text = src.slice(m.index!, end + 1);
      const expr = text.match(/className=\{([^}]*)\}/);
      for (const name of expr ? (expr[1].match(/\b[A-Za-z_]\w*\b/g) ?? []) : []) {
        const def = src.match(new RegExp(`const ${name}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`));
        if (def) text += ` ${def[2]}`;
      }
      out.push({ where: `${file}:${src.slice(0, m.index).split('\n').length}`, file, text });
    }
  }
  return out;
}

const allowed = (t: { file: string; text: string }) =>
  FLOOR_ALLOWLIST.some((a) => a.file === t.file && t.text.includes(a.contains));

describe('every interactive element has a 24 px floor (generic scan)', () => {
  const tags = interactiveTags();

  it('finds the elements it is meant to check', () => {
    expect(tags.length).toBeGreaterThan(60);
    for (const f of ['components/LicenseList.tsx', 'components/settings/PrWebhookSecrets.tsx', 'app/settings/SettingsClient.tsx']) {
      expect(tags.some((t) => t.file === f), f).toBe(true);
    }
  });

  it('gives every button, link and select a floor class or an allowlist entry', () => {
    const offenders = tags.filter((t) => !FLOOR.test(t.text) && !allowed(t)).map((t) => t.where);
    expect(
      offenders,
      'these controls have no 24 px floor class: add min-h-6 (or h-6/size-6 or larger, or py-1.5 or larger) to the tag, ' +
        'or add a FLOOR_ALLOWLIST entry with the size you measured in the browser',
    ).toEqual([]);
  });

  it('has no stale allowlist entry (each one matches exactly one tag without a floor class)', () => {
    for (const a of FLOOR_ALLOWLIST) {
      const match = tags.filter((t) => t.file === a.file && t.text.includes(a.contains));
      expect(match.length, `${a.file} ${a.contains}`).toBe(1);
      expect(FLOOR.test(match[0].text), `${a.file} ${a.contains} has a floor class already`).toBe(false);
    }
  });

  it('recognises floor classes and rejects the ones that are too small', () => {
    for (const ok of ['min-h-6', 'min-h-11', 'h-6', 'h-10', 'size-6', 'py-1.5', 'py-2', 'py-3']) {
      expect(FLOOR.test(`x ${ok} y`), ok).toBe(true);
    }
    for (const bad of ['min-h-5', 'h-5', 'size-4', 'py-1', 'py-0.5', 'py-1.5x', 'max-h-6', 'h-60x', 'min-h-0', 'md:py-2', 'sm:min-h-6']) {
      expect(FLOOR.test(`x ${bad} y`), bad).toBe(false);
    }
  });
});
