import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmModal } from '@/components/ConfirmModal';

function render(open: boolean): string {
  return renderToStaticMarkup(
    createElement(ConfirmModal, {
      open,
      title: 'Policy löschen',
      message: 'Wirklich löschen?',
      confirmLabel: 'Löschen',
      cancelLabel: 'Abbrechen',
      onConfirm: () => undefined,
      onCancel: () => undefined,
      destructive: true,
    }),
  );
}

describe('ConfirmModal markup', () => {
  it('renders a modal dialog with its labels while open', () => {
    const html = render(true);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirm-modal-title"');
    expect(html).toContain('>Policy löschen</h3>');
    expect(html).toContain('>Abbrechen</button>');
    expect(html).toContain('>Löschen</button>');
  });

  it('renders nothing while closed', () => {
    expect(render(false)).toBe('');
  });
});
