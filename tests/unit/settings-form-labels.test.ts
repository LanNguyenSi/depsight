import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { SettingsClient } from '@/app/settings/SettingsClient';

vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}));

function render(): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, null, createElement(SettingsClient)),
  );
}

/** Ranges of the children of every wrapping <label> element in the markup. */
function labelWrappedRanges(html: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /<\/?label\b/g;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      if (open >= 0) ranges.push([open, m.index]);
      open = -1;
    } else if (open < 0) {
      open = m.index;
    }
  }
  return ranges;
}

function labelTags(html: string): string[] {
  return [...html.matchAll(/<label\b[^>]*>/g)].map((x) => x[0]);
}

function unnamedControls(html: string): string[] {
  const ranges = labelWrappedRanges(html);
  const bad: string[] = [];
  for (const m of html.matchAll(/<(select|input)\b[^>]*>/g)) {
    const tag = m[0];
    if (/\baria-label="/.test(tag)) continue;
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (id && labelTags(html).some((l) => l.includes(`for="${id}"`))) continue;
    if (ranges.some(([s, e]) => m.index > s && m.index < e)) continue;
    bad.push(tag);
  }
  return bad;
}

describe('SettingsClient accessible names', () => {
  it('every select and input has a programmatic name (aria-label, label[for]+id, or wrapping label)', () => {
    expect(unnamedControls(render())).toEqual([]);
  });

  it('pairs every visible label with its control through for/id', () => {
    const html = render();
    const forIds = labelTags(html)
      .map((l) => l.match(/\bfor="([^"]+)"/)?.[1])
      .filter((x): x is string => Boolean(x));
    expect(forIds.length).toBeGreaterThanOrEqual(6);
    for (const id of forIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('associates the Slack severity label with the severity select', () => {
    const html = render();
    const label = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map((x) => x[0])
      .find((l) => l.includes('Mindest-Schweregrad'));
    expect(label).toBeDefined();
    const id = label!.match(/\bfor="([^"]+)"/)![1];
    const re = new RegExp(`<select\\b[^>]*id="${id}"[^>]*>`);
    expect(html).toMatch(re);
  });

  it('gives the token name input an aria-label because it has no visible label', () => {
    const html = render();
    const m = html.match(/<input\b[^>]*type="text"[^>]*placeholder="Name \(z\. B\.[^"]*"[^>]*>/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('aria-label="Token-Name"');
  });

  it('wraps the token create form into a column below sm so the button stays visible', () => {
    const html = render();
    const form = html.match(/<form\b[^>]*>/);
    expect(form).not.toBeNull();
    const cls = form![0].match(/class="([^"]*)"/)![1].split(/\s+/);
    expect(cls).toContain('flex-col');
    expect(cls).toContain('sm:flex-row');
  });
});
