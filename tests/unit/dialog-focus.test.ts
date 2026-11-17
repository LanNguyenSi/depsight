import { describe, expect, it } from 'vitest';
import { isEscapeKey, nextFocusIndex, restoreTarget } from '@/components/dialog-focus';

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
