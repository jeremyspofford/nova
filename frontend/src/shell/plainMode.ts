/** Plain mode: chat in the content area instead of the universe canvas.
 *
 *  Jeremy, 2026-08-06: "I want a view in the nova application that is not nova
 *  at all — full screen chat with the side bar, and if I clicked on a sidebar
 *  item, like library, it would open that in the nova view field."
 *
 *  ONE KEY, ONE EVENT, and both live here because two components need to agree
 *  about it and neither owns the other: the rail flips it, the shell renders
 *  from it. `localStorage` alone would leave the shell showing the old view
 *  until a reload, and a React context for a single boolean is more machinery
 *  than the boolean.
 *
 *  A PREFERENCE, NOT A ROUTE. The surfaces already have routes and the plain
 *  view is not one of them — it is which backdrop those routes are drawn over.
 *  Making it a route would mean /library rendering differently depending on
 *  how it was reached, and it would put "the universe" one URL away from being
 *  a tab, which it is deliberately not.
 */
export const PLAIN_KEY = 'nova.plainMode';
export const PLAIN_EVENT = 'nova:plain-mode';

export function plainMode(): boolean {
  try {
    return localStorage.getItem(PLAIN_KEY) === '1';
  } catch {
    return false;      // private browsing, a locked-down profile — canvas wins
  }
}

export function setPlainMode(on: boolean): void {
  try {
    localStorage.setItem(PLAIN_KEY, on ? '1' : '0');
  } catch {
    /* not persisting is survivable; not switching is not */
  }
  window.dispatchEvent(new CustomEvent(PLAIN_EVENT, { detail: { on } }));
}
