// The kill key in the app (FR-207, docs/04 §5): while Nova controls a computer's screen and the
// app has focus, the `screen.killKey` binding stops control at once. The global key on the device
// is novad's; this covers the app window. The listener runs in the capture phase so nothing in the
// app (a dialog, the composer) can swallow it first, and one key press stops each computer once
// even when the panel and the global indicator both listen.
import { useEffect, useRef } from 'react';
import { matchesBinding, normalizeBinding } from '../keys.ts';
import { useServices } from '../services.tsx';

/** The setting's form ("Escape", "ctrl+alt+k", "ctrl alt k") as an app binding, or null. */
export function killBinding(key: string, mac: boolean): string | null {
  return normalizeBinding(key.trim().replace(/\s+/g, '+'), mac);
}

const claimed = new WeakMap<Event, Set<string>>();

/** True the first time an event asks to stop `computerId`; false for every later listener. */
export function claimKill(e: Event, computerId: string): boolean {
  const set = claimed.get(e) ?? new Set<string>();
  if (set.has(computerId)) return false;
  set.add(computerId);
  claimed.set(e, set);
  return true;
}

/** Calls `onKill` when the kill key is pressed anywhere in the app while `active`. */
export function useKillKey(active: boolean, killKey: string, onKill: (e: KeyboardEvent) => void) {
  const { registry } = useServices();
  const mac = registry.platform.mac;
  const handler = useRef(onKill);
  useEffect(() => {
    handler.current = onKill;
  });
  const binding = killBinding(killKey, mac);
  useEffect(() => {
    if (!active || !binding) return;
    const listen = (e: KeyboardEvent) => {
      if (e.repeat || !matchesBinding(e, binding, mac)) return;
      handler.current(e);
    };
    window.addEventListener('keydown', listen, true);
    return () => window.removeEventListener('keydown', listen, true);
  }, [active, binding, mac]);
}
