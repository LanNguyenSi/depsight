// Pure decision helpers for dialog and menu keyboard handling. The DOM
// wiring (listeners, focus calls) lives with the components; these
// functions hold the branch logic so it can be unit-tested in node.

/** Keys that close a dialog or menu: only Escape counts. */
export function isEscapeKey(key: string): boolean {
  return key === 'Escape';
}

/**
 * Next focus index when Tab is pressed inside a container with `count`
 * focusable elements. `current` is the index of the focused element, or -1
 * when focus is outside the list (for example on the backdrop). Tab from
 * the last element wraps to the first and Shift+Tab from the first wraps
 * to the last, so focus stays inside the dialog.
 */
export function nextFocusIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return 0;
  if (current < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey) return (current - 1 + count) % count;
  return (current + 1) % count;
}

/**
 * Where to move focus when a dialog closes: the element that had focus
 * before the dialog opened (`previous`), or `null` meaning the body, when
 * there was no previous element or it is no longer in the document (for
 * example the list row that held it re-rendered). `isConnected` is the
 * detached check the caller reads from the DOM.
 */
export function restoreTarget<T extends Element>(
  previous: T | null,
  isConnected: boolean,
): T | null {
  if (!previous) return null;
  return isConnected ? previous : null;
}

/**
 * Focus target on close, in this order: the preferred opener (the trigger
 * the caller holds a ref to), then the fallback (a persistent element that
 * outlives the opener, such as the button of the menu the opener sits in),
 * then the element that had focus when the dialog opened, then `null`
 * (body). Each candidate counts only while it is in the document. Safari
 * does not focus a button on click, so the previously focused element can
 * be the page body instead of the trigger.
 */
export function returnFocusTarget<T extends Element>(
  preferred: T | null,
  previous: T | null,
  fallback: T | null = null,
): T | null {
  return restoreTarget(preferred, preferred?.isConnected ?? false)
    ?? restoreTarget(fallback, fallback?.isConnected ?? false)
    ?? restoreTarget(previous, previous?.isConnected ?? false);
}

/** The slice of a keyboard event `handleDialogKey` uses. */
export interface DialogKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface DialogKeyContext<T extends { focus(): void }> {
  /** Tab stops inside the dialog, in order. */
  focusables: readonly T[];
  /** The element that has focus now (`null` when none). */
  active: unknown;
  onEscape: () => void;
}

/**
 * Key handling of a modal dialog. Escape is consumed (stopPropagation, so
 * an outer menu does not also close) and calls `onEscape`. Tab and
 * Shift+Tab are always consumed (preventDefault) and move focus to the
 * next element with wrap-around, so focus never leaves the dialog; with no
 * focusable element Tab is left alone. Every other key is untouched.
 */
export function handleDialogKey<T extends { focus(): void }>(
  e: DialogKeyEvent,
  { focusables, active, onEscape }: DialogKeyContext<T>,
): void {
  if (isEscapeKey(e.key)) {
    e.stopPropagation();
    onEscape();
    return;
  }
  if (e.key !== 'Tab') return;
  if (focusables.length === 0) return;
  const current = focusables.findIndex((el) => el === active);
  const next = nextFocusIndex(current, focusables.length, e.shiftKey);
  e.preventDefault();
  focusables[next]?.focus();
}

/**
 * Hides body scroll while a dialog is open. Returns the function that puts
 * the previous `overflow` value back (an empty string stays empty).
 */
export function lockBodyScroll(style: { overflow: string }): () => void {
  const previous = style.overflow;
  style.overflow = 'hidden';
  return () => {
    style.overflow = previous;
  };
}

/**
 * Which button takes focus when a confirm dialog opens: cancel for a
 * destructive one, so Enter cannot confirm a deletion, confirm otherwise.
 */
export function initialFocusTarget(destructive: boolean): 'cancel' | 'confirm' {
  return destructive ? 'cancel' : 'confirm';
}

/** Elements Tab can reach, used to build the focus list of a dialog. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Menu items a key can land on: enabled `menuitem` elements inside a `role="menu"` popup. */
export const MENU_ITEM_SELECTOR = '[role="menu"] [role="menuitem"]:not([disabled])';

/** The enabled menu items below `root`, in document order (empty without a root). */
export function enabledMenuItems(root: ParentNode | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)) : [];
}

/** What a key does inside an open menu. */
export type MenuKeyAction =
  | { kind: 'focus'; index: number }
  | { kind: 'close'; restoreFocus: boolean }
  | { kind: 'none' };

/**
 * Keyboard contract of a menu with `count` enabled items. `current` is the
 * index of the focused item among the enabled ones, or -1 when focus is on
 * the trigger or elsewhere. ArrowDown and ArrowUp move with wrap (from -1
 * they enter at the first and the last item), Home and End jump to the
 * ends, Escape closes and returns focus to the trigger, Tab closes and lets
 * focus continue. Disabled items are not in the list, so they are skipped.
 * With no enabled item the arrows and Home/End do nothing; Escape and Tab
 * still close.
 */
export function menuKeyAction(key: string, current: number, count: number): MenuKeyAction {
  if (isEscapeKey(key)) return { kind: 'close', restoreFocus: true };
  if (key === 'Tab') return { kind: 'close', restoreFocus: false };
  if (count <= 0) return { kind: 'none' };
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: current < 0 ? 0 : (current + 1) % count };
    case 'ArrowUp':
      return { kind: 'focus', index: current < 0 ? count - 1 : (current - 1 + count) % count };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: count - 1 };
    default:
      return { kind: 'none' };
  }
}

/**
 * Which item a closed menu's trigger opens onto for a key: ArrowDown the
 * first, ArrowUp the last. Enter and Space open through the button's click
 * and land on the first item like a mouse open.
 */
export function menuOpenFocus(key: string): 'first' | 'last' | null {
  if (key === 'ArrowDown') return 'first';
  if (key === 'ArrowUp') return 'last';
  return null;
}

export interface MenuKeyContext<T extends { focus(): void }> {
  /** Enabled items, in order. */
  items: readonly T[];
  /** The element that has focus now (`null` when none). */
  active: unknown;
  /**
   * Whether the key event started inside the menu or its trigger. Escape
   * closes from anywhere; the other keys only count inside, so a dialog
   * portaled out of the menu keeps its own keys.
   */
  inside: boolean;
  /** Close the menu; `restoreFocus` asks for focus on the trigger. */
  close: (restoreFocus: boolean) => void;
}

/**
 * Applies `menuKeyAction` to a key event: focus moves are consumed
 * (preventDefault stops the page from scrolling), Escape is consumed, Tab is
 * left to the browser after closing.
 */
export function handleMenuKey<T extends { focus(): void }>(
  e: Pick<DialogKeyEvent, 'key' | 'preventDefault'>,
  { items, active, inside, close }: MenuKeyContext<T>,
): void {
  if (!inside && !isEscapeKey(e.key)) return;
  const action = menuKeyAction(e.key, items.findIndex((el) => el === active), items.length);
  if (action.kind === 'focus') {
    e.preventDefault();
    items[action.index]?.focus();
  } else if (action.kind === 'close') {
    if (e.key === 'Escape') e.preventDefault();
    close(action.restoreFocus);
  }
}
