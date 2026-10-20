// Shared bits for settings pages and the workspace surfaces (docs/14 §1.2).
import { useEffect, useRef } from 'react';
import { defineMessages, fmt } from '@nova/i18n';

/**
 * "Managed by your organization": a live re-export of packages/ui's binding (never a copy), so it
 * follows the locale; kept for the areas that import it. New code reads `UI_TEXT.managed` from
 * @nova/ui at render, as the settings pages do.
 */
export { MANAGED_TEXT as MANAGED } from '@nova/ui';

/** Run `fn` every `ms` while `active`; the latest `fn` is always the one called. */
export function useInterval(fn: () => void, ms: number, active = true): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

const WHEN_TEXT = defineMessages('settings.when', {
  never: 'never',
  unknown: 'unknown',
  justNow: 'just now',
  minutesAgo: '{n, plural, other {# min ago}}',
  hoursAgo: '{n, plural, other {# h ago}}',
});

/** A short, human time in the active locale: "just now", "5 min ago", "3 h ago", then a date. */
export function formatWhen(iso: string | null, now = Date.now()): string {
  if (!iso) return WHEN_TEXT.never;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return WHEN_TEXT.unknown;
  const s = Math.round((now - t) / 1000);
  if (s < 45 && s > -45) return WHEN_TEXT.justNow;
  if (s > 0 && s < 3600) return WHEN_TEXT.minutesAgo({ n: Math.round(s / 60) });
  if (s > 0 && s < 86_400) return WHEN_TEXT.hoursAgo({ n: Math.round(s / 3600) });
  return fmt.date(t, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** `list` with the item at `i` moved by `delta` places (clamped); a new array. */
export function moveItem<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  const next = [...list];
  if (i < 0 || i >= list.length || i === j) return next;
  const [item] = next.splice(i, 1);
  next.splice(j, 0, item as T);
  return next;
}

/**
 * "1 chat", "2 chats". English only: converted areas use an ICU plural message instead
 * (`'{n, plural, one {# chat} other {# chats}}'`, FR-016).
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * After a Move up/down, keep focus on the moved row: the same button if it is still enabled,
 * otherwise its opposite (the first or last row disables one of them). Rows carry
 * `data-move-key`; buttons carry `data-move="up" | "down"`.
 */
export function focusMoved(root: HTMLElement | null, key: string, dir: 'up' | 'down'): void {
  setTimeout(() => {
    const rows = root?.querySelectorAll<HTMLElement>('[data-move-key]') ?? [];
    const row = [...rows].find((r) => r.dataset.moveKey === key);
    // Only this row's own buttons, not those of rows nested inside it.
    const button = (d: string) =>
      [...(row?.querySelectorAll<HTMLButtonElement>(`[data-move="${d}"]`) ?? [])].find(
        (b) => b.closest('[data-move-key]') === row,
      );
    const same = button(dir);
    const other = button(dir === 'up' ? 'down' : 'up');
    (same && !same.disabled ? same : other)?.focus();
  }, 0);
}
