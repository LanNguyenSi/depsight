import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmModal } from '@/components/ConfirmModal';

function render(destructive: boolean) {
  return renderToStaticMarkup(
    createElement(ConfirmModal, {
      open: true,
      title: 'Title',
      message: 'Message',
      confirmLabel: 'Confirm',
      cancelLabel: 'Cancel',
      onConfirm: () => undefined,
      onCancel: () => undefined,
      destructive,
    }),
  );
}

function confirmTag(html: string): string {
  const m = html.match(/<button[^>]*>Confirm<\/button>/);
  if (!m) throw new Error(`no confirm button in ${html}`);
  return m[0];
}

describe('ConfirmModal markup', () => {
  it('is a labelled modal dialog', () => {
    const html = render(false);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirm-modal-title"');
  });

  it('renders nothing when closed', () => {
    expect(
      renderToStaticMarkup(
        createElement(ConfirmModal, {
          open: false,
          title: 't',
          message: 'm',
          confirmLabel: 'c',
          cancelLabel: 'x',
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    ).toBe('');
  });

  it('destructive confirm is white on red with a red-700 hover', () => {
    const tag = confirmTag(render(true));
    expect(tag).toContain('text-white');
    expect(tag).toContain('bg-red-600');
    expect(tag).toContain('hover:bg-red-700');
    expect(tag).not.toContain('hover:bg-red-500');
  });

  it('non-destructive confirm is white on blue with a blue-700 hover', () => {
    const tag = confirmTag(render(false));
    expect(tag).toContain('bg-blue-600');
    expect(tag).toContain('hover:bg-blue-700');
    expect(tag).not.toContain('red');
  });

  // Autofocus runs only in a browser. initialFocusTarget is unit-tested in
  // dialog-focus.test.ts; pin that the component maps its answer to the
  // right button, so a swap cannot make Enter confirm a deletion.
  it('maps the destructive focus target to the cancel button', () => {
    const source = readFileSync(resolve(__dirname, '../../components/ConfirmModal.tsx'), 'utf8');
    expect(source).toContain("initialFocusTarget(destructive) === 'cancel' ? cancelRef.current : confirmRef.current");
  });
});
