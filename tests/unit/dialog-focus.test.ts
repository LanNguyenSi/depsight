import { describe, expect, it, vi } from 'vitest';
import {
  handleDialogKey,
  initialFocusTarget,
  isEscapeKey,
  lockBodyScroll,
  nextFocusIndex,
  restoreTarget,
  returnFocusTarget,
} from '@/components/dialog-focus';

describe('isEscapeKey', () => {
  it('closes on Escape', () => {
    expect(isEscapeKey('Escape')).toBe(true);
  });

  it('does not close on other keys', () => {
    expect(isEscapeKey('Tab')).toBe(false);
    expect(isEscapeKey('Enter')).toBe(false);
    expect(isEscapeKey('a')).toBe(false);
  });

  it('does not close on a near-miss spelling', () => {
    expect(isEscapeKey('Esc')).toBe(false);
    expect(isEscapeKey('escape')).toBe(false);
  });
});

describe('nextFocusIndex', () => {
  it('Tab moves to the next control', () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(1, 3, false)).toBe(2);
  });

  it('Tab from the last control wraps to the first', () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
  });

  it('Shift+Tab moves to the previous control', () => {
    expect(nextFocusIndex(2, 3, true)).toBe(1);
    expect(nextFocusIndex(1, 3, true)).toBe(0);
  });

  it('Shift+Tab from the first control wraps to the last', () => {
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });

  it('Tab with focus outside the list enters at the first control', () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
  });

  it('Shift+Tab with focus outside the list enters at the last control', () => {
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it('returns 0 for an empty container instead of dividing by zero', () => {
    expect(nextFocusIndex(0, 0, false)).toBe(0);
    expect(nextFocusIndex(-1, 0, true)).toBe(0);
  });

  it('a single control cycles to itself in both directions', () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });
});

describe('restoreTarget', () => {
  it('returns the previous element when it is still in the document', () => {
    const previous = { focus: () => undefined } as unknown as Element;
    expect(restoreTarget(previous, true)).toBe(previous);
  });

  it('returns null when the previous element was detached from the document', () => {
    const previous = { focus: () => undefined } as unknown as Element;
    expect(restoreTarget(previous, false)).toBeNull();
  });

  it('returns null when there was no previous element', () => {
    expect(restoreTarget(null, true)).toBeNull();
    expect(restoreTarget(null, false)).toBeNull();
  });
});

describe('returnFocusTarget', () => {
  const el = (isConnected: boolean) => ({ isConnected }) as unknown as Element;

  it('prefers the named opener over the previously focused element', () => {
    const preferred = el(true);
    const previous = el(true);
    expect(returnFocusTarget(preferred, previous)).toBe(preferred);
  });

  it('falls back to the previously focused element when the opener is detached', () => {
    const previous = el(true);
    expect(returnFocusTarget(el(false), previous)).toBe(previous);
  });

  it('falls back to the previously focused element when no opener is named', () => {
    const previous = el(true);
    expect(returnFocusTarget(null, previous)).toBe(previous);
  });

  it('prefers the fallback over the previously focused element when the opener is detached', () => {
    const fallback = el(true);
    const previous = el(true);
    expect(returnFocusTarget(el(false), previous, fallback)).toBe(fallback);
  });

  it('prefers the opener over the fallback while the opener is in the document', () => {
    const preferred = el(true);
    expect(returnFocusTarget(preferred, el(true), el(true))).toBe(preferred);
  });

  it('skips a detached fallback and uses the previously focused element', () => {
    const previous = el(true);
    expect(returnFocusTarget(el(false), previous, el(false))).toBe(previous);
    expect(returnFocusTarget(null, previous, null)).toBe(previous);
  });

  it('returns null (body) when opener, fallback and previous are all gone', () => {
    expect(returnFocusTarget(el(false), el(false), el(false))).toBeNull();
    expect(returnFocusTarget(null, null, null)).toBeNull();
  });

  it('returns null (body) when neither element is in the document', () => {
    expect(returnFocusTarget(el(false), el(false))).toBeNull();
    expect(returnFocusTarget(null, el(false))).toBeNull();
    expect(returnFocusTarget(el(false), null)).toBeNull();
    expect(returnFocusTarget(null, null)).toBeNull();
  });
});

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function stops(n: number) {
  return Array.from({ length: n }, () => ({ focus: vi.fn() }));
}

describe('handleDialogKey', () => {
  it('Escape stops propagation and calls onEscape, without touching focus or the default', () => {
    const e = keyEvent('Escape');
    const onEscape = vi.fn();
    const f = stops(2);
    handleDialogKey(e, { focusables: f, active: f[0], onEscape });
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(f[0].focus).not.toHaveBeenCalled();
    expect(f[1].focus).not.toHaveBeenCalled();
  });

  it('Escape reaches onEscape even with nothing focusable', () => {
    const e = keyEvent('Escape');
    const onEscape = vi.fn();
    handleDialogKey(e, { focusables: [], active: null, onEscape });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('Tab prevents the default and focuses the next element', () => {
    const e = keyEvent('Tab');
    const f = stops(3);
    handleDialogKey(e, { focusables: f, active: f[0], onEscape: vi.fn() });
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(f[1].focus).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('Tab from the last element wraps to the first', () => {
    const e = keyEvent('Tab');
    const f = stops(3);
    handleDialogKey(e, { focusables: f, active: f[2], onEscape: vi.fn() });
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(f[0].focus).toHaveBeenCalledTimes(1);
  });

  it('Shift+Tab from the first element wraps to the last and prevents the default', () => {
    const e = keyEvent('Tab', true);
    const f = stops(3);
    handleDialogKey(e, { focusables: f, active: f[0], onEscape: vi.fn() });
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(f[2].focus).toHaveBeenCalledTimes(1);
  });

  it('Tab with focus outside the dialog enters at the first element', () => {
    const e = keyEvent('Tab');
    const f = stops(2);
    handleDialogKey(e, { focusables: f, active: {}, onEscape: vi.fn() });
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(f[0].focus).toHaveBeenCalledTimes(1);
  });

  it('Tab with nothing focusable is left alone', () => {
    const e = keyEvent('Tab');
    handleDialogKey(e, { focusables: [], active: null, onEscape: vi.fn() });
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('other keys touch nothing', () => {
    const f = stops(2);
    const onEscape = vi.fn();
    for (const key of ['Enter', 'a', ' ', 'ArrowDown']) {
      const e = keyEvent(key);
      handleDialogKey(e, { focusables: f, active: f[0], onEscape });
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.stopPropagation).not.toHaveBeenCalled();
    }
    expect(onEscape).not.toHaveBeenCalled();
    expect(f[0].focus).not.toHaveBeenCalled();
    expect(f[1].focus).not.toHaveBeenCalled();
  });
});

describe('lockBodyScroll', () => {
  it('hides overflow while locked and puts the previous value back', () => {
    const style = { overflow: 'auto' };
    const restore = lockBodyScroll(style);
    expect(style.overflow).toBe('hidden');
    restore();
    expect(style.overflow).toBe('auto');
  });

  it('restores an empty value as empty', () => {
    const style = { overflow: '' };
    const restore = lockBodyScroll(style);
    expect(style.overflow).toBe('hidden');
    restore();
    expect(style.overflow).toBe('');
  });
});

describe('initialFocusTarget', () => {
  it('focuses cancel for a destructive dialog so Enter cannot confirm a deletion', () => {
    expect(initialFocusTarget(true)).toBe('cancel');
  });

  it('focuses confirm for a non-destructive dialog', () => {
    expect(initialFocusTarget(false)).toBe('confirm');
  });
});
