import { describe, expect, it, vi } from 'vitest';
import {
  enabledMenuItems,
  handleDialogKey,
  handleMenuKey,
  initialFocusTarget,
  isEscapeKey,
  lockBodyScroll,
  MENU_ITEM_SELECTOR,
  menuKeyAction,
  menuOpenFocus,
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

describe('menuKeyAction', () => {
  it('ArrowDown moves to the next item and wraps from the last to the first', () => {
    expect(menuKeyAction('ArrowDown', 0, 3)).toEqual({ kind: 'focus', index: 1 });
    expect(menuKeyAction('ArrowDown', 2, 3)).toEqual({ kind: 'focus', index: 0 });
  });

  it('ArrowUp moves to the previous item and wraps from the first to the last', () => {
    expect(menuKeyAction('ArrowUp', 2, 3)).toEqual({ kind: 'focus', index: 1 });
    expect(menuKeyAction('ArrowUp', 0, 3)).toEqual({ kind: 'focus', index: 2 });
  });

  it('enters at the first item on ArrowDown and the last on ArrowUp when no item has focus', () => {
    expect(menuKeyAction('ArrowDown', -1, 4)).toEqual({ kind: 'focus', index: 0 });
    expect(menuKeyAction('ArrowUp', -1, 4)).toEqual({ kind: 'focus', index: 3 });
  });

  it('Home goes to the first item and End to the last', () => {
    expect(menuKeyAction('Home', 2, 5)).toEqual({ kind: 'focus', index: 0 });
    expect(menuKeyAction('End', 2, 5)).toEqual({ kind: 'focus', index: 4 });
  });

  it('stays on the only item', () => {
    expect(menuKeyAction('ArrowDown', 0, 1)).toEqual({ kind: 'focus', index: 0 });
    expect(menuKeyAction('ArrowUp', 0, 1)).toEqual({ kind: 'focus', index: 0 });
  });

  it('Escape closes and restores focus, Tab closes and leaves focus to the browser', () => {
    expect(menuKeyAction('Escape', 1, 3)).toEqual({ kind: 'close', restoreFocus: true });
    expect(menuKeyAction('Tab', 1, 3)).toEqual({ kind: 'close', restoreFocus: false });
  });

  it('does nothing for arrows and Home/End when no item is enabled, but still closes', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(menuKeyAction(key, -1, 0)).toEqual({ kind: 'none' });
    }
    expect(menuKeyAction('Escape', -1, 0)).toEqual({ kind: 'close', restoreFocus: true });
    expect(menuKeyAction('Tab', -1, 0)).toEqual({ kind: 'close', restoreFocus: false });
  });

  it('ignores other keys', () => {
    for (const key of ['a', 'Enter', ' ', 'ArrowLeft', 'PageDown']) {
      expect(menuKeyAction(key, 1, 3)).toEqual({ kind: 'none' });
    }
  });
});

describe('menuOpenFocus', () => {
  it('opens onto the first item for ArrowDown and the last for ArrowUp', () => {
    expect(menuOpenFocus('ArrowDown')).toBe('first');
    expect(menuOpenFocus('ArrowUp')).toBe('last');
  });

  it('leaves Enter, Space and other keys to the button click', () => {
    for (const key of ['Enter', ' ', 'Escape', 'Home', 'a']) {
      expect(menuOpenFocus(key)).toBeNull();
    }
  });
});

describe('handleMenuKey', () => {
  function setup(key: string, opts: { active?: number; inside?: boolean; count?: number } = {}) {
    const count = opts.count ?? 3;
    const items = Array.from({ length: count }, () => ({ focus: vi.fn() }));
    const prevented = vi.fn();
    const close = vi.fn();
    handleMenuKey(
      { key, preventDefault: prevented },
      {
        items,
        active: opts.active === undefined ? null : items[opts.active],
        inside: opts.inside ?? true,
        close,
      },
    );
    return { items, prevented, close };
  }

  it('focuses the target item and consumes the key', () => {
    const { items, prevented } = setup('ArrowDown', { active: 0 });
    expect(items[1].focus).toHaveBeenCalledTimes(1);
    expect(prevented).toHaveBeenCalled();
  });

  it('wraps ArrowDown from the last item', () => {
    const { items } = setup('ArrowDown', { active: 2 });
    expect(items[0].focus).toHaveBeenCalledTimes(1);
  });

  it('Escape closes with focus restore and is consumed', () => {
    const { close, prevented } = setup('Escape', { active: 1 });
    expect(close).toHaveBeenCalledWith(true);
    expect(prevented).toHaveBeenCalled();
  });

  it('Tab closes without restoring focus and is not consumed', () => {
    const { close, prevented } = setup('Tab', { active: 1 });
    expect(close).toHaveBeenCalledWith(false);
    expect(prevented).not.toHaveBeenCalled();
  });

  it('Escape closes from outside the menu, other keys outside are ignored', () => {
    const esc = setup('Escape', { inside: false });
    expect(esc.close).toHaveBeenCalledWith(true);
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']) {
      const r = setup(key, { inside: false, active: 1 });
      expect(r.close).not.toHaveBeenCalled();
      expect(r.prevented).not.toHaveBeenCalled();
      for (const item of r.items) expect(item.focus).not.toHaveBeenCalled();
    }
  });

  it('does not throw or consume arrows with no enabled item', () => {
    const { prevented, close } = setup('ArrowDown', { count: 0 });
    expect(prevented).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('enabledMenuItems', () => {
  it('returns an empty list without a root and queries the shared selector otherwise', () => {
    expect(enabledMenuItems(null)).toEqual([]);
    const found = [{ id: 'a' }, { id: 'b' }];
    const querySelectorAll = vi.fn(() => found);
    expect(enabledMenuItems({ querySelectorAll } as unknown as ParentNode)).toEqual(found);
    expect(querySelectorAll).toHaveBeenCalledWith(MENU_ITEM_SELECTOR);
  });

  it('selects enabled menuitems inside a menu only', () => {
    expect(MENU_ITEM_SELECTOR).toContain('[role="menuitem"]');
    expect(MENU_ITEM_SELECTOR).toContain(':not([disabled])');
  });
});
