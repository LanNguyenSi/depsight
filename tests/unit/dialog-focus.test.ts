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
  menuTriggerAction,
  handleTriggerKey,
  triggerKeyHandler,
  openFocusIndex,
  isPointerOutside,
  mobileNavKeyAction,
  bindMenu,
  bindMobileNav,
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

describe('menuTriggerAction', () => {
  it('opens a closed menu onto the first item for ArrowDown and the last for ArrowUp', () => {
    expect(menuTriggerAction('ArrowDown', false)).toBe('first');
    expect(menuTriggerAction('ArrowUp', false)).toBe('last');
  });

  it('leaves Enter, Space and other keys to the button click', () => {
    for (const key of ['Enter', ' ', 'Escape', 'Home', 'a']) {
      expect(menuTriggerAction(key, false)).toBe('none');
    }
  });

  it('does nothing while the menu is open', () => {
    expect(menuTriggerAction('ArrowDown', true)).toBe('none');
    expect(menuTriggerAction('ArrowUp', true)).toBe('none');
  });
});

describe('handleTriggerKey', () => {
  function press(key: string, open: boolean) {
    const preventDefault = vi.fn();
    const openMenu = vi.fn();
    handleTriggerKey({ key, preventDefault }, open, openMenu);
    return { preventDefault, openMenu };
  }

  it('ArrowDown on a closed trigger opens onto first and consumes the key', () => {
    const r = press('ArrowDown', false);
    expect(r.openMenu).toHaveBeenCalledWith('first');
    expect(r.preventDefault).toHaveBeenCalled();
  });

  it('ArrowUp on a closed trigger opens onto last', () => {
    expect(press('ArrowUp', false).openMenu).toHaveBeenCalledWith('last');
  });

  it('does not open for Enter, or when already open, and leaves the key alone', () => {
    for (const r of [press('Enter', false), press('ArrowDown', true)]) {
      expect(r.openMenu).not.toHaveBeenCalled();
      expect(r.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('triggerKeyHandler', () => {
  function make(open: boolean) {
    const focusRef: { current: 'first' | 'last' } = { current: 'first' };
    const setOpen = vi.fn();
    return { focusRef, setOpen, handler: triggerKeyHandler(open, focusRef, setOpen) };
  }

  it('ArrowUp records last and opens', () => {
    const r = make(false);
    r.handler({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(r.focusRef.current).toBe('last');
    expect(r.setOpen).toHaveBeenCalledWith(true);
  });

  it('ArrowDown records first and opens', () => {
    const r = make(false);
    r.focusRef.current = 'last';
    r.handler({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(r.focusRef.current).toBe('first');
    expect(r.setOpen).toHaveBeenCalledWith(true);
  });

  it('Enter and an open menu change nothing', () => {
    const closed = make(false);
    closed.handler({ key: 'Enter', preventDefault: vi.fn() });
    const open = make(true);
    open.handler({ key: 'ArrowUp', preventDefault: vi.fn() });
    for (const r of [closed, open]) {
      expect(r.setOpen).not.toHaveBeenCalled();
      expect(r.focusRef.current).toBe('first');
    }
  });
});

describe('openFocusIndex', () => {
  it('first is 0 and last is count - 1', () => {
    expect(openFocusIndex(4, 'first')).toBe(0);
    expect(openFocusIndex(4, 'last')).toBe(3);
    expect(openFocusIndex(1, 'last')).toBe(0);
  });

  it('is -1 without items', () => {
    expect(openFocusIndex(0, 'first')).toBe(-1);
    expect(openFocusIndex(0, 'last')).toBe(-1);
  });
});

describe('isPointerOutside', () => {
  const inside = { contains: (n: unknown) => n === 'in' };

  it('is outside when no container holds the target', () => {
    expect(isPointerOutside('out', [inside])).toBe(true);
  });

  it('is inside when a container holds the target', () => {
    expect(isPointerOutside('in', [inside])).toBe(false);
    expect(isPointerOutside('in', [null, inside])).toBe(false);
  });

  it('is never outside without a present container', () => {
    expect(isPointerOutside('out', [null])).toBe(false);
    expect(isPointerOutside('out', [])).toBe(false);
  });

  it('ignores targets the ignore predicate accepts', () => {
    const ignore = (t: unknown) => t === 'portal';
    expect(isPointerOutside('portal', [inside], ignore)).toBe(false);
    expect(isPointerOutside('portal', [inside])).toBe(true);
    expect(isPointerOutside('out', [inside], ignore)).toBe(true);
  });
});

describe('mobileNavKeyAction', () => {
  it('closes on a plain Escape', () => {
    expect(mobileNavKeyAction('Escape', false, false)).toBe('close');
  });

  it('ignores an Escape the user menu handles', () => {
    expect(mobileNavKeyAction('Escape', true, false)).toBe('ignore');
    expect(mobileNavKeyAction('Escape', false, true)).toBe('ignore');
    expect(mobileNavKeyAction('Escape', true, true)).toBe('ignore');
  });

  it('ignores other keys', () => {
    for (const key of ['Tab', 'ArrowDown', 'Enter', 'a']) {
      expect(mobileNavKeyAction(key, false, false)).toBe('ignore');
    }
  });
});

type Listener = (e: never) => void;

function fakeDoc(active: unknown = null) {
  const listeners = new Map<string, Listener>();
  return {
    activeElement: active,
    addEventListener: vi.fn((type: string, fn: Listener) => { listeners.set(type, fn); }),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    }),
    fire(type: string, e: object) {
      (listeners.get(type) as unknown as (e: object) => void)?.(e);
    },
    has: (type: string) => listeners.has(type),
  };
}

describe('bindMenu', () => {
  function setup(openFocus: 'first' | 'last' = 'first', count = 3) {
    const focusRef = { current: openFocus };
    const items = Array.from({ length: count }, () => ({ focus: vi.fn() }));
    const doc = fakeDoc();
    const container = {
      contains: (n: unknown) => n === 'in' || items.includes(n as never),
      querySelectorAll: () => items,
    };
    const trigger = { focus: vi.fn() };
    const setOpen = vi.fn();
    const cleanup = bindMenu({
      doc: doc as never,
      container: container as never,
      trigger,
      openFocus: focusRef,
      ignore: (t) => !!(t as { portal?: boolean } | null)?.portal,
      setOpen,
    });
    return { items, doc, trigger, setOpen, cleanup, focusRef };
  }

  it('focuses the first item on open, the last for openFocus last', () => {
    const a = setup('first');
    expect(a.items[0].focus).toHaveBeenCalledTimes(1);
    expect(a.items[2].focus).not.toHaveBeenCalled();
    const b = setup('last');
    expect(b.items[2].focus).toHaveBeenCalledTimes(1);
    expect(b.items[0].focus).not.toHaveBeenCalled();
  });

  it('resets the open target to first once read', () => {
    expect(setup('last').focusRef.current).toBe('first');
  });

  it('Escape closes and returns focus to the trigger', () => {
    const r = setup();
    r.doc.fire('keydown', { key: 'Escape', target: 'in', preventDefault: vi.fn() });
    expect(r.setOpen).toHaveBeenCalledWith(false);
    expect(r.trigger.focus).toHaveBeenCalledTimes(1);
  });

  it('Tab closes without moving focus to the trigger', () => {
    const r = setup();
    r.doc.fire('keydown', { key: 'Tab', target: 'in', preventDefault: vi.fn() });
    expect(r.setOpen).toHaveBeenCalledWith(false);
    expect(r.trigger.focus).not.toHaveBeenCalled();
  });

  it('ArrowDown moves from the active item', () => {
    const r = setup();
    r.doc.activeElement = r.items[0];
    r.doc.fire('keydown', { key: 'ArrowDown', target: r.items[0], preventDefault: vi.fn() });
    expect(r.items[1].focus).toHaveBeenCalledTimes(1);
  });

  it('a mousedown outside closes, inside and portal targets do not', () => {
    const r = setup();
    r.doc.fire('mousedown', { target: 'out' });
    expect(r.setOpen).toHaveBeenCalledTimes(1);
    expect(r.setOpen).toHaveBeenCalledWith(false);
    r.doc.fire('mousedown', { target: 'in' });
    r.doc.fire('mousedown', { target: { portal: true } });
    expect(r.setOpen).toHaveBeenCalledTimes(1);
  });

  it('cleanup removes both listeners', () => {
    const r = setup();
    expect(r.doc.has('keydown') && r.doc.has('mousedown')).toBe(true);
    r.cleanup();
    expect(r.doc.has('keydown') || r.doc.has('mousedown')).toBe(false);
  });
});

describe('bindMobileNav', () => {
  function setup(opts: { userMenuOpen?: boolean } = {}) {
    const doc = fakeDoc();
    const button = { focus: vi.fn() };
    const setOpen = vi.fn();
    const cleanup = bindMobileNav({
      doc: doc as never,
      header: { contains: (n: unknown) => n === 'header' },
      button,
      userMenuOpen: () => opts.userMenuOpen ?? false,
      setOpen,
    });
    return { doc, button, setOpen, cleanup };
  }

  it('Escape closes and focuses the menu button', () => {
    const r = setup();
    r.doc.fire('keydown', { key: 'Escape', target: 'header', defaultPrevented: false });
    expect(r.setOpen).toHaveBeenCalledWith(false);
    expect(r.button.focus).toHaveBeenCalledTimes(1);
  });

  it('Escape with focus on the closed user menu trigger still closes the nav', () => {
    const r = setup();
    r.doc.fire('keydown', { key: 'Escape', target: 'user', defaultPrevented: false });
    expect(r.setOpen).toHaveBeenCalledWith(false);
  });

  it('other keys do nothing', () => {
    const r = setup();
    r.doc.fire('keydown', { key: 'Tab', target: 'header', defaultPrevented: false });
    expect(r.setOpen).not.toHaveBeenCalled();
  });

  it('an Escape while the user menu is open, or already prevented, is left alone', () => {
    const open = setup({ userMenuOpen: true });
    open.doc.fire('keydown', { key: 'Escape', target: 'header', defaultPrevented: false });
    const prevented = setup();
    prevented.doc.fire('keydown', { key: 'Escape', target: 'header', defaultPrevented: true });
    for (const r of [open, prevented]) {
      expect(r.setOpen).not.toHaveBeenCalled();
      expect(r.button.focus).not.toHaveBeenCalled();
    }
  });

  it('a mousedown outside the header closes, inside does not', () => {
    const r = setup();
    r.doc.fire('mousedown', { target: 'header' });
    expect(r.setOpen).not.toHaveBeenCalled();
    r.doc.fire('mousedown', { target: 'elsewhere' });
    expect(r.setOpen).toHaveBeenCalledWith(false);
  });

  it('cleanup removes both listeners', () => {
    const r = setup();
    r.cleanup();
    expect(r.doc.has('keydown') || r.doc.has('mousedown')).toBe(false);
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
