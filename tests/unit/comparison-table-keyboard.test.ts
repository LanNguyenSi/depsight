// The overview comparison table must work without a mouse: every sortable
// column is a real button, the active column is announced via aria-sort, and
// opening a repository is a button in the name cell.
import { createElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Direct mode: hooks are replaced so the component function can be called
// outside a renderer and its element tree inspected (handlers, aria props).
// useState is keyed by call order (sortCol, sortDir, page), so equal initial
// values cannot collide. The shim must be extended when the component gains a
// hook.
const direct = vi.hoisted(() => ({
  on: false,
  state: [] as unknown[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  calls: 0,
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!direct.on) return actual.useState(init);
      const i = direct.calls++;
      const setter = vi.fn();
      direct.setters[i] = setter;
      return [i in direct.state ? direct.state[i] : init, setter];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => (direct.on ? fn() : actual.useMemo(fn, deps)),
  };
});

import { LocaleProvider } from '@/lib/i18n';
import { getTranslations } from '@/lib/i18n/translations';
import { RepoComparisonTable } from '@/components/overview/RepoComparisonTable';

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return {
    ...actual,
    useLocale: () => (direct.on ? { t: getTranslations('en'), locale: 'en' } : actual.useLocale()),
  };
});

const repos = [
  {
    repoId: 'r-1', fullName: 'acme/api', language: 'TypeScript', lastScannedAt: '2026-01-02T03:04:05.000Z',
    riskScore: 12, cveCount: 1, criticalCount: 0, highCount: 1, licenseIssues: 0, outdatedDeps: 2, totalDeps: 10, healthScore: 80,
  },
  {
    repoId: 'r-2', fullName: 'acme/web', language: null, lastScannedAt: null,
    riskScore: 50, cveCount: 3, criticalCount: 1, highCount: 1, licenseIssues: 1, outdatedDeps: 0, totalDeps: 0, healthScore: 40,
  },
];

beforeEach(() => {
  direct.on = false;
  direct.state = [];
  direct.setters = [];
  direct.calls = 0;
});

function render(props: { onSelectRepo?: (id: string) => void } = {}): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { initialLocale: 'en' }, createElement(RepoComparisonTable, { repos, ...props })),
  );
}

function headers(html: string): string[] {
  return html.match(/<th\b[^>]*>[\s\S]*?<\/th>/g) ?? [];
}

type Props = Record<string, unknown> & { children?: unknown };

function findAll(node: unknown, type: string, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) {
    node.forEach((n) => findAll(n, type, out));
  } else if (isValidElement(node)) {
    const el = node as ReactElement<Props>;
    if (el.type === type) out.push(el);
    findAll(el.props.children, type, out);
  }
  return out;
}

function tree(props: { onSelectRepo?: (id: string) => void } = {}): ReactElement {
  direct.on = true;
  direct.calls = 0;
  direct.setters = [];
  return RepoComparisonTable({ repos, ...props }) as ReactElement;
}

describe('RepoComparisonTable keyboard access', () => {
  it('puts a type=button inside every column header, with scope=col', () => {
    const ths = headers(render());
    expect(ths).toHaveLength(8);
    for (const th of ths) {
      expect(th).toContain('scope="col"');
      expect(th).toMatch(/<button type="button"/);
    }
  });

  it('keeps the sort handler on the button, not on the th', () => {
    const ths = findAll(tree(), 'th');
    expect(ths).toHaveLength(8);
    for (const th of ths) {
      expect(th.props.onClick).toBeUndefined();
      const buttons = findAll(th, 'button');
      expect(buttons).toHaveLength(1);
      expect(typeof buttons[0].props.onClick).toBe('function');
      expect(buttons[0].props.type).toBe('button');
    }
  });

  it('sorts by the clicked header key and toggles direction on the active column', () => {
    const keys = ['name', 'health', 'risk', 'cves', 'critical', 'licenses', 'outdated', 'scanned'];
    const [SORT_COL, SORT_DIR, PAGE] = [0, 1, 2];
    keys.forEach((key, idx) => {
      const ths = findAll(tree(), 'th');
      const button = findAll(ths[idx], 'button')[0];
      (button.props.onClick as () => void)();
      if (key === 'health') {
        // Active column (default health, asc): direction flips, column stays.
        expect(direct.setters[SORT_COL]).not.toHaveBeenCalled();
        const updater = direct.setters[SORT_DIR].mock.calls[0][0] as (d: string) => string;
        expect(updater('asc')).toBe('desc');
        expect(updater('desc')).toBe('asc');
      } else {
        expect(direct.setters[SORT_COL]).toHaveBeenCalledTimes(1);
        expect(direct.setters[SORT_COL]).toHaveBeenCalledWith(key);
        expect(direct.setters[SORT_DIR]).toHaveBeenCalledWith(key === 'name' ? 'asc' : 'desc');
      }
      expect(direct.setters[PAGE]).toHaveBeenCalledWith(1);
    });
  });

  it('marks only the active column (health, ascending by default) with aria-sort', () => {
    const sorted = headers(render()).filter((th) => th.includes('aria-sort='));
    expect(sorted).toHaveLength(1);
    expect(sorted[0]).toContain('aria-sort="ascending"');
    expect(sorted[0]).toContain('Health');
  });

  it('announces descending on the active column and nothing on the others', () => {
    direct.state = ['risk', 'desc'];
    const ths = findAll(tree(), 'th');
    const withSort = ths.filter((th) => th.props['aria-sort'] !== undefined);
    expect(withSort).toHaveLength(1);
    expect(withSort[0].props['aria-sort']).toBe('descending');
    expect(JSON.stringify(findAll(withSort[0], 'button')[0].props.children)).toContain('Risk');
  });

  it('hides the visual arrow from assistive technology', () => {
    expect(render()).toMatch(/<span aria-hidden="true" class="ml-1 text-blue-400">/);
  });

  it('renders a name button per row with onSelectRepo and plain text without it', () => {
    const withCb = render({ onSelectRepo: () => {} });
    expect(withCb).toMatch(/<button type="button"[^>]*>acme\/api<\/button>/);
    expect(withCb).toMatch(/<button type="button"[^>]*>acme\/web<\/button>/);
    const without = render();
    expect(without).not.toMatch(/<button type="button"[^>]*>acme\/(api|web)<\/button>/);
    expect(without).toContain('>acme/api</div>');
    expect(without).not.toMatch(/<tr class="[^"]*cursor-pointer/);
    expect(withCb).toMatch(/<tr class="[^"]*cursor-pointer/);
  });

  it('calls onSelectRepo exactly once when the name button is activated, even with the row click', () => {
    const cb = vi.fn();
    const body = findAll(tree({ onSelectRepo: cb }), 'tbody')[0];
    const row = findAll(body, 'tr').find((r) => findAll(r, 'button').length > 0)!;
    const button = findAll(row, 'button')[0];
    let stopped = false;
    const event = { stopPropagation: () => { stopped = true; } };
    (button.props.onClick as (e: unknown) => void)(event);
    // Model the bubble: the row handler only runs when the button let it through.
    if (!stopped) (row.props.onClick as () => void)();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('still opens a repository by row click (mouse)', () => {
    const cb = vi.fn();
    const row = findAll(tree({ onSelectRepo: cb }), 'tbody').flatMap((b) => findAll(b, 'tr'))[0];
    (row.props.onClick as () => void)();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
