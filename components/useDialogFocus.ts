'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { FOCUSABLE_SELECTOR, isEscapeKey, nextFocusIndex, returnFocusTarget } from '@/components/dialog-focus';

interface UseDialogFocusOptions {
  open: boolean;
  /** The element that holds the dialog content; Tab is trapped inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Picks the element that takes focus when the dialog opens. */
  initialFocus: () => HTMLElement | null;
  /** Called on Escape. The key event is consumed so no outer handler (a menu) also reacts. */
  onEscape: () => void;
  /**
   * Element to give focus back to on close. Falls back to whatever had focus
   * when the dialog opened (Safari does not focus a button on click, so the
   * trigger cannot always be read from `document.activeElement`).
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Hide body scroll while open and restore the previous value on close and unmount. */
  lockScroll?: boolean;
}

/**
 * Modal behaviour shared by the dialogs: focus moves in on open, Tab stays
 * inside, Escape closes only the dialog, focus returns to the opener on
 * close. The branch decisions live in `dialog-focus.ts`.
 */
export function useDialogFocus({
  open,
  rootRef,
  initialFocus,
  onEscape,
  returnFocusRef,
  lockScroll = false,
}: UseDialogFocusOptions): void {
  // Latest callbacks without re-running the effect (and re-stealing focus)
  // when a caller passes a fresh function on every render.
  const onEscapeRef = useRef(onEscape);
  const initialFocusRef = useRef(initialFocus);
  useEffect(() => {
    onEscapeRef.current = onEscape;
    initialFocusRef.current = initialFocus;
  });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = returnFocusRef?.current ?? null;
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = 'hidden';
    initialFocusRef.current()?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (isEscapeKey(e.key)) {
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = rootRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const current =
        document.activeElement instanceof HTMLElement
          ? focusables.indexOf(document.activeElement)
          : -1;
      const next = nextFocusIndex(current, focusables.length, e.shiftKey);
      e.preventDefault();
      focusables[next]?.focus();
    }
    // Capture phase on window runs before the document-level listeners of
    // the page, so stopPropagation keeps an Escape from reaching them.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (lockScroll) document.body.style.overflow = previousOverflow;
      // Return focus to the opener; if it is gone from the document (the
      // list row re-rendered), fall back to body.
      const target = returnFocusTarget(opener, previouslyFocused);
      if (target) {
        target.focus();
      } else {
        document.body.focus();
      }
    };
  }, [open, lockScroll, rootRef, returnFocusRef]);
}
