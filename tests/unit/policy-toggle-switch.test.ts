import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import { PolicyList } from '@/components/PolicyList';

const POLICY_BASE = {
  type: 'LICENSE_DENY' as const,
  severity: 'HIGH' as const,
  rule: { deniedLicenses: ['GPL-3.0'] },
  createdAt: '2026-01-01T00:00:00.000Z',
};

function render() {
  return renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(PolicyList, {
        initialPolicies: [
          { ...POLICY_BASE, id: 'p1', name: 'No GPL', enabled: true },
          { ...POLICY_BASE, id: 'p2', name: 'Draft rule', enabled: false },
        ],
      }),
    ),
  );
}

/** The opening tag of the enable/disable switch of one policy row. */
function switchTag(html: string, ariaLabel: string): string {
  const m = html.match(/<button[^>]*role="switch"[^>]*aria-label="([^"]*)"[^>]*>/);
  const all = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((x) => x[0]);
  const hit = all.find((tag) => tag.includes(`aria-label="${ariaLabel}"`));
  if (!hit) throw new Error(`no switch with aria-label ${ariaLabel} (found ${m ? m[1] : 'none'}) in ${html}`);
  return hit;
}

describe('PolicyList enable/disable switch', () => {
  it('renders an enabled policy as a switch with aria-checked true, translated title and focus ring', () => {
    const tag = switchTag(render(), 'Policy No GPL aktivieren oder deaktivieren');
    expect(tag).toContain('role="switch"');
    expect(tag).toContain('aria-checked="true"');
    expect(tag).toContain('title="Deaktivieren"');
    expect(tag).toContain('focus-visible:ring-2');
    expect(tag).not.toContain('focus:outline-none');
  });

  it('renders a disabled policy as a switch with aria-checked false and the enable title', () => {
    const tag = switchTag(render(), 'Policy Draft rule aktivieren oder deaktivieren');
    expect(tag).toContain('role="switch"');
    expect(tag).toContain('aria-checked="false"');
    expect(tag).toContain('title="Aktivieren"');
    expect(tag).toContain('focus-visible:ring-2');
  });

  it('names each switch after the policy it toggles', () => {
    const html = render();
    const labels = [...html.matchAll(/role="switch"[^>]*aria-label="([^"]+)"/g)].map((x) => x[1]);
    expect(labels).toEqual([
      'Policy No GPL aktivieren oder deaktivieren',
      'Policy Draft rule aktivieren oder deaktivieren',
    ]);
  });
});
