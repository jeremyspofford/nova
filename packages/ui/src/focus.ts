// Focus helpers shared by overlays (docs/04 §4.4: logical focus order, full keyboard operation).

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// The element that last had focus. A button disabled while it works (a check, an upload) drops
// focus to the page before the dialog it opens appears; the dialog then returns focus here.
let lastFocused: HTMLElement | null = null;
if (typeof document !== 'undefined')
  document.addEventListener(
    'focusin',
    (e) => {
      if (e.target instanceof HTMLElement && e.target !== document.body) lastFocused = e.target;
    },
    true,
  );

/**
 * Where focus should go back to when an overlay that opens now closes: the focused element, or
 * the one focused last when focus has fallen to the page (WCAG 2.4.3).
 */
export function focusOrigin(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return lastFocused?.isConnected ? lastFocused : null;
}

/** Focus `el` if it can still take focus (connected, not disabled); true when it did. */
export function restoreFocus(el: HTMLElement | null): boolean {
  if (!el?.isConnected || el.matches(':disabled')) return false;
  el.focus();
  return document.activeElement === el;
}

export function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** Keep Tab and Shift+Tab inside `root`. Returns true when it moved focus. */
export interface TabKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export function trapTab(e: TabKeyEvent, root: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || !root) return false;
  const items = focusableWithin(root);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    e.preventDefault();
    root.focus();
    return true;
  }
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * The reading direction at `el`: the nearest `dir="ltr"` or `dir="rtl"` around it, else the
 * document's (FR-016). In right-to-left, Left and Right arrow keys and horizontal drags mean the
 * opposite along the inline axis, so they follow what the user sees.
 */
export function readingDirection(el?: Element | null): 'ltr' | 'rtl' {
  if (typeof document === 'undefined') return 'ltr';
  const at = el?.closest('[dir="rtl"], [dir="ltr"]') ?? document.documentElement;
  return at.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr';
}

/**
 * Index after a roving-focus key press, or null when the key is not a navigation key. A
 * horizontal list in right-to-left moves to the next item with Left (`direction` defaults to the
 * document's).
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  orientation: 'vertical' | 'horizontal' = 'vertical',
  direction: 'ltr' | 'rtl' = readingDirection(),
): number | null {
  if (count === 0) return null;
  const rtl = direction === 'rtl';
  const next = orientation === 'vertical' ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight';
  const prev = orientation === 'vertical' ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === next) return (current + 1) % count;
  if (key === prev) return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
