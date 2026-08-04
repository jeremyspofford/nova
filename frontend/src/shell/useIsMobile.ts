import { useEffect, useState } from 'react';

/** The one definition of "phone" in the UI: below Tailwind's `md`.
 *
 *  It exists because the phone and the desktop want different *shapes*, not
 *  just different sizes — a routed surface is a card on a scrim with a mouse
 *  and a full-screen page on a phone, and no media query can swap a modal
 *  for a page. Anything that only needs to reflow should still use `md:`.
 */
export const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
