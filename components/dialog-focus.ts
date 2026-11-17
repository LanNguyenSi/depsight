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

/** Elements Tab can reach, used to build the focus list of a dialog. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
