import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionsMenuTrigger, RepoTabButton } from '@/app/dashboard/DashboardChrome';

function tagOf(html: string): string {
  const m = html.match(/^<button[^>]*>/);
  if (!m) throw new Error(`no button tag in ${html}`);
  return m[0];
}

describe('RepoTabButton', () => {
  it('marks the active tab with aria-current="page"', () => {
    const tag = tagOf(
      renderToStaticMarkup(
        createElement(RepoTabButton, { active: true, label: 'CVE', count: 3, onSelect: () => undefined }),
      ),
    );
    expect(tag).toContain('aria-current="page"');
  });

  it('leaves inactive tabs without aria-current', () => {
    const tag = tagOf(
      renderToStaticMarkup(
        createElement(RepoTabButton, { active: false, label: 'Lizenzen', count: undefined, onSelect: () => undefined }),
      ),
    );
    expect(tag).not.toContain('aria-current');
  });

  it('shows the count only when it is above zero', () => {
    const withCount = renderToStaticMarkup(
      createElement(RepoTabButton, { active: false, label: 'CVE', count: 7, onSelect: () => undefined }),
    );
    const withoutCount = renderToStaticMarkup(
      createElement(RepoTabButton, { active: false, label: 'CVE', count: 0, onSelect: () => undefined }),
    );
    expect(withCount).toContain('>7</span>');
    expect(withoutCount).not.toContain('<span');
  });
});

describe('ActionsMenuTrigger', () => {
  it('is a closed menu button with haspopup and expanded=false', () => {
    const tag = tagOf(
      renderToStaticMarkup(
        createElement(ActionsMenuTrigger, { open: false, label: 'Aktionen', onClick: () => undefined }),
      ),
    );
    expect(tag).toContain('aria-haspopup="menu"');
    expect(tag).toContain('aria-expanded="false"');
  });

  it('reports expanded=true while the menu is open', () => {
    const tag = tagOf(
      renderToStaticMarkup(
        createElement(ActionsMenuTrigger, { open: true, label: 'Aktionen', onClick: () => undefined }),
      ),
    );
    expect(tag).toContain('aria-haspopup="menu"');
    expect(tag).toContain('aria-expanded="true"');
  });
});
