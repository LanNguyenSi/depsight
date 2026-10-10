import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ForkScanSelect } from '@/components/settings/ForkScanSelect';

const labels = {
  title: 'Fork pull requests',
  defaultOn: 'Default (scan)',
  defaultOff: 'Default (ignore)',
  scan: 'Scan',
  ignore: 'Ignore',
  publicNote: 'PUBLIC-NOTE',
  noSecretNote: 'NO-SECRET-NOTE',
};

function render(row: { configured: boolean; private: boolean; scanForks: boolean | null }) {
  return renderToStaticMarkup(
    createElement(ForkScanSelect, { row, forksDefault: true, busy: false, labels, onChange: () => undefined }),
  );
}

/** The opening tag of the element whose content starts with `text`. */
function tagOf(html: string, tag: 'select' | 'option', text: string): string {
  const m = html.match(new RegExp(`<${tag}[^>]*>${text}`));
  if (!m) throw new Error(`no <${tag}> for ${text} in ${html}`);
  return m[0];
}

describe('ForkScanSelect', () => {
  it('public repository with a secret: select enabled, Scan option disabled, note shown', () => {
    const html = render({ configured: true, private: false, scanForks: null });
    expect(tagOf(html, 'select', '<option')).not.toContain('disabled=""');
    expect(tagOf(html, 'option', 'Scan')).toContain('disabled=""');
    expect(tagOf(html, 'option', 'Ignore')).not.toContain('disabled=""');
    expect(html).toContain('PUBLIC-NOTE');
    expect(html).not.toContain('NO-SECRET-NOTE');
  });

  it('repository without a secret: select disabled with the no-secret note', () => {
    const html = render({ configured: false, private: true, scanForks: null });
    expect(tagOf(html, 'select', '<option')).toContain('disabled=""');
    expect(html).toContain('NO-SECRET-NOTE');
    expect(html).not.toContain('PUBLIC-NOTE');
  });

  it('private repository with a secret: nothing disabled, no note', () => {
    const html = render({ configured: true, private: true, scanForks: null });
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('PUBLIC-NOTE');
    expect(html).not.toContain('NO-SECRET-NOTE');
  });

  it('public repository with a stored Scan: Scan stays selected and disabled, note shown', () => {
    const html = render({ configured: true, private: false, scanForks: true });
    const scan = tagOf(html, 'option', 'Scan');
    expect(scan).toContain('selected=""');
    expect(scan).toContain('disabled=""');
    expect(html).toContain('PUBLIC-NOTE');
  });
});
