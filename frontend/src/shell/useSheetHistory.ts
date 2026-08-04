import { useEffect, useRef } from 'react';

/** Make a full-screen sheet answer the back gesture.
 *
 *  The phone's surfaces are pages now, and a page you cannot back out of is
 *  a trap: on Android the system back would leave the app with the menu
 *  still on screen, and an installed iOS app has no browser chrome to press
 *  instead. Sheets held in component state (the menu, the inbox, a memory
 *  card) are invisible to the router, so they each borrow one history entry
 *  while they are open.
 *
 *  Back pops the entry and closes the sheet. Closing by hand consumes the
 *  entry instead, so the stack never grows a step that does nothing — and
 *  the guard means we only spend a `back()` on an entry we actually pushed,
 *  never on the operator's real navigation.
 */
export function useSheetHistory(open: boolean, close: () => void): void {
  // `close` is usually a fresh arrow each render; a ref keeps the effect
  // keyed on the thing that actually changed — whether the sheet is open.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    window.history.pushState({ novaSheet: true }, '');
    const onPop = () => closeRef.current();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (window.history.state?.novaSheet) window.history.back();
    };
  }, [open]);
}
