// Which window a path opens in (FR-009, docs/04 §5.1): a window already showing the place is
// focused; a deep link or notification otherwise goes to the window used last; "open in a new
// window" makes a new one unless one already shows exactly that place.
import { pathKey, threadIdOf } from './routes.ts';

export interface WindowInfo {
  id: number;
  /** The app path the window shows now (path and query). */
  path: string;
  /** When it last had focus (ms); 0 when never. */
  focusedAt: number;
}

export type WindowChoice =
  { kind: 'focus'; id: number } | { kind: 'navigate'; id: number } | { kind: 'create' };

/** For a deep link or notification: focus the window at the place, else reuse the last one. */
export function windowForLink(windows: readonly WindowInfo[], path: string): WindowChoice {
  const key = pathKey(path);
  const showing = windows.find((w) => pathKey(w.path) === key && key !== '/');
  if (showing)
    return showing.path === path
      ? { kind: 'focus', id: showing.id }
      : { kind: 'navigate', id: showing.id };
  const last = lastUsed(windows);
  return last ? { kind: 'navigate', id: last.id } : { kind: 'create' };
}

/** For "open in a new window": a new window unless one already shows that exact place. */
export function windowForDetach(windows: readonly WindowInfo[], path: string): WindowChoice {
  const showing = windows.find((w) => w.path === path);
  return showing ? { kind: 'focus', id: showing.id } : { kind: 'create' };
}

export function lastUsed(windows: readonly WindowInfo[]): WindowInfo | null {
  let best: WindowInfo | null = null;
  for (const w of windows) if (!best || w.focusedAt > best.focusedAt) best = w;
  return best;
}

/** The chat a quick send or a capture goes to by default: the one open in the last used window. */
export function currentThread(windows: readonly WindowInfo[]): string | null {
  const last = lastUsed(windows);
  return last ? threadIdOf(last.path) : null;
}

/** The app path of a Hub window's URL, or null when it is not on the Hub's origin. */
export function pathOfUrl(url: string, hubOrigin: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== hubOrigin) return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
