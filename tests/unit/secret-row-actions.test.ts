import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretRowActions } from '@/components/settings/SecretRowActions';

const labels = {
  generate: 'Generate',
  rotate: 'Rotate',
  remove: 'Remove',
  working: 'Working',
  unavailable: 'Secrets unavailable: set a key',
};

function render(props: { configured: boolean; available: boolean; busy?: boolean }) {
  return renderToStaticMarkup(
    createElement(SecretRowActions, {
      busy: false,
      labels,
      onGenerate: () => undefined,
      onRotate: () => undefined,
      onRemove: () => undefined,
      ...props,
    }),
  );
}

/** The opening tag of the button whose label is `label`. */
function buttonTag(html: string, label: string): string {
  const m = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  if (!m) throw new Error(`no button labelled ${label} in ${html}`);
  return m[0];
}

describe('SecretRowActions', () => {
  it('enables Generate for an unconfigured repository when key material is available', () => {
    const tag = buttonTag(render({ configured: false, available: true }), 'Generate');
    expect(tag).not.toContain('disabled=""');
    expect(tag).not.toContain('title=');
  });

  it('disables Generate with the reason when key material is unavailable', () => {
    const tag = buttonTag(render({ configured: false, available: false }), 'Generate');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="Secrets unavailable: set a key"');
  });

  it('enables Rotate and Remove for a configured repository when available', () => {
    const html = render({ configured: true, available: true });
    expect(buttonTag(html, 'Rotate')).not.toContain('disabled=""');
    expect(buttonTag(html, 'Remove')).not.toContain('disabled=""');
  });

  it('disables Rotate with the reason but keeps Remove enabled when unavailable', () => {
    const html = render({ configured: true, available: false });
    const rotate = buttonTag(html, 'Rotate');
    expect(rotate).toContain('disabled=""');
    expect(rotate).toContain('title="Secrets unavailable: set a key"');
    expect(buttonTag(html, 'Remove')).not.toContain('disabled=""');
  });

  it('shows the working label and disables the button while busy', () => {
    const tag = buttonTag(render({ configured: false, available: true, busy: true }), 'Working');
    expect(tag).toContain('disabled=""');
  });
});
