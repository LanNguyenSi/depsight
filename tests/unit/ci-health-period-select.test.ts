import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { CIHealthTab } from '@/components/dashboard/CIHealthTab';

function render(): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, null, createElement(CIHealthTab, { repoId: 'repo-1' })),
  );
}

describe('CIHealthTab period select', () => {
  it('names the period select through aria-label', () => {
    const m = render().match(/<select\b[^>]*>/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('aria-label="Zeitraum"');
  });

  it('still offers the three periods as options', () => {
    const html = render();
    expect(html).toContain('<option value="1">Letzter Tag</option>');
    expect(html).toContain('<option value="7">Letzte 7 Tage</option>');
    expect(html).toContain('<option value="30" selected="">Letzte 30 Tage</option>');
  });
});
