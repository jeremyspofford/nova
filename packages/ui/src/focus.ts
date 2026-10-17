// Focus helpers shared by overlays (docs/04 §4.4: logical focus order, full keyboard operation).

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

/** Index after a roving-focus key press, or null when the key is not a navigation key. */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  orientation: 'vertical' | 'horizontal' = 'vertical',
): number | null {
  if (count === 0) return null;
  const next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const prev = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  if (key === next) return (current + 1) % count;
  if (key === prev) return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
