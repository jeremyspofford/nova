// Small shared hooks.
import { useCallback, useSyncExternalStore } from 'react';

/** Live result of a CSS media query; `fallback` when matchMedia is unavailable. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener?.('change', fn);
      return () => mq.removeEventListener?.('change', fn);
    },
    [query],
  );
  const get = () =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback;
  return useSyncExternalStore(subscribe, get, () => fallback);
}

/** Layout bands from docs/04 §4.3: phones get one column; the sidebar collapses below 1100 px. */
export type Layout = 'phone' | 'compact' | 'wide';

export function useLayout(): { layout: Layout; inspectorFits: boolean } {
  const phone = useMediaQuery('(max-width: 640px)', false);
  const wide = useMediaQuery('(min-width: 1100px)', true);
  const inspectorFits = useMediaQuery('(min-width: 1280px)', true);
  return { layout: phone ? 'phone' : wide ? 'wide' : 'compact', inspectorFits };
}

export function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'color', 'range', 'file'].includes(
      el.type,
    );
  }
  return false;
}
