import { useLayoutEffect, useState } from 'react';

/** How much of the shell's content area the side panels are covering, in px.
 *
 *  The canvas has always centred Nova in the clear band between the Atlas
 *  (left) and the docked chat (right) — that's `leftInset` in pages/Brain.tsx,
 *  plus the chat width subtracted from the canvas size. The routed overlays
 *  never knew: they centre inside a box that spans the whole content area,
 *  so they drift right by half the chat width and slide under it once the
 *  chat is dragged past its default.
 *
 *  Brain owns the panel state and publishes derived pixels here. It has to
 *  be a store and not just a `nova:*` event like the rest of the shell's
 *  cross-surface signals: `atlasOpen` is not persisted anywhere, so an
 *  overlay that mounts *after* the last dispatch would have nothing to read.
 *  Subscribers need a pull at mount as well as a push on change. */

/** Breathing room each side of a card that has run out of band — this is
 *  what the old `max-w-[calc(100vw-1rem)]` cap was really buying. */
export const GUTTER = 8;

export interface ShellInsets {
  /** left-hand panels (the Memory Atlas), including its 16px gutter */
  left: number;
  /** right-hand panels (the docked chat) */
  right: number;
}

let current: ShellInsets = { left: 0, right: 0 };
const subscribers = new Set<() => void>();

/** Publish the band. Call from an effect, never from inside a state updater —
 *  Rail.tsx:94 records why (React flags a re-render mid-render). */
export function setShellInsets(next: ShellInsets) {
  if (next.left === current.left && next.right === current.right) return;
  current = next;
  subscribers.forEach(fn => fn());
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Deliberately not useSyncExternalStore: that subscribes from a PASSIVE
 *  effect, which runs after paint. Brain publishes from a layout effect in
 *  the same commit, so on a cold load straight onto an overlay route the
 *  scrim would render against the seed, miss the publish, and only be
 *  corrected on the next frame — one visible jump. Resyncing in a layout
 *  effect closes that window: Brain is the earlier sibling in AppShell, so
 *  by the time this runs the band is already known. */
export function useShellInsets(): ShellInsets {
  const [band, setBand] = useState(current);
  useLayoutEffect(() => {
    setBand(current);   // catch a publish that landed before we subscribed
    return subscribe(() => setBand(current));
  }, []);
  return band;
}
