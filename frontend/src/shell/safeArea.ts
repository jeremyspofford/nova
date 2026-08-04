/** The phone's safe areas — MEASURED, then published as CSS variables.
 *
 *  Everything in the app used to read `env(safe-area-inset-top)` directly,
 *  and on the installed iOS app that number is a lie: a screenshot on
 *  2026-08-04 put the chat header's hamburger 26pt from the top of the
 *  screen, under the clock, while the page was plainly being drawn
 *  full-bleed beneath a 58pt status bar. The header was unreachable — the
 *  only way to see it was to drag the whole page down, which is also how the
 *  white band behind the app became visible.
 *
 *  A padding that trusts a number the browser gets wrong is not a fix, so
 *  this reads what the browser actually resolves and substitutes a status
 *  bar's worth of room ONLY when all three of these hold:
 *
 *    - we are running as an installed app (a browser tab has real chrome
 *      above us and never needs this),
 *    - the browser resolved the top inset to nothing,
 *    - the viewport genuinely covers the whole screen — so something IS
 *      being drawn over us.
 *
 *  All three are read from the live environment, so the day the browser
 *  reports the inset honestly the substitution stops applying by itself.
 *  There is no device list to maintain.
 */

/** Apple's two status-bar heights. Only ever used as the substitute above,
 *  and only chosen between by whether the device reports a home-indicator
 *  inset — every iPhone that has one also has a notch or an island. */
const STATUS_BAR_INSET = 59;
const STATUS_BAR_CLASSIC = 20;

/** Resolve a CSS length in the live document. A hidden fixed probe is the
 *  only way to ask "what did env() actually come out as?" — env() is not
 *  readable from JS any other way. */
function resolve(probe: HTMLElement, css: string): number {
  probe.style.height = css;
  return probe.getBoundingClientRect().height;
}

function installedApp(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    // iOS's own flag, still the only true answer for a home-screen app
    // added before it honoured the manifest's display mode
    || (navigator as { standalone?: boolean }).standalone === true;
}

/** Does our viewport cover the whole screen? Compared on the long edge so
 *  the answer survives rotation — iOS reports screen dimensions unrotated. */
function coversScreen(): boolean {
  const screenLong = Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0);
  if (!screenLong) return false;
  return Math.max(window.innerWidth, window.innerHeight) >= screenLong - 4;
}

/** An open keyboard shrinks the visual viewport and zeroes the bottom inset
 *  underneath itself. Re-measuring then would shorten the composer's padding
 *  and — because the viewport no longer covers the screen — retract the top
 *  substitution, so the header would jump under the status bar mid-sentence.
 *  Nothing about the notch changed; hold the last answer. */
function keyboardOpen(): boolean {
  const vv = window.visualViewport;
  return !!vv && vv.height < window.innerHeight - 100;
}

let published = false;

function measure(): void {
  if (published && keyboardOpen()) return;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;'
    + 'pointer-events:none;height:0';
  document.body.appendChild(probe);
  try {
    const top = resolve(probe, 'env(safe-area-inset-top, 0px)');
    const bottom = resolve(probe, 'env(safe-area-inset-bottom, 0px)');
    const substitute = installedApp() && coversScreen()
      ? (bottom > 0 ? STATUS_BAR_INSET : STATUS_BAR_CLASSIC)
      : 0;
    const root = document.documentElement.style;
    root.setProperty('--nova-safe-top', `${top > 0 ? top : substitute}px`);
    root.setProperty('--nova-safe-bottom', `${bottom}px`);
    published = true;
  } finally {
    probe.remove();
  }
}

/** Publish the insets now, and again whenever the viewport changes shape
 *  (rotation, split view, a phone unfolding). Cheap: two layout reads. */
export function trackSafeArea(): void {
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', measure);
  window.visualViewport?.addEventListener('resize', measure);
}
