/**
 * The phone's safe areas — MEASURED, then published as CSS variables.
 *
 * Ported from v3's shell/safeArea.ts (design, not dependencies: it is sixty
 * lines of DOM with nothing v3-specific). v3 learned this the same way v4 did
 * on 2026-09-15: on an installed iOS app, `env(safe-area-inset-top)` can
 * resolve to 0 while the page is plainly being drawn full-bleed under a 59pt
 * status bar, so a padding that trusts env() puts the first line of the
 * page under the clock.
 *
 * So this reads what the browser ACTUALLY resolves and substitutes a status
 * bar's worth of room only when all three of these hold:
 *
 *   - we are running as an installed app (a browser tab has real chrome
 *     above us and never needs this),
 *   - the browser resolved the top inset to nothing,
 *   - the viewport genuinely covers the whole screen — so something IS being
 *     drawn over us.
 *
 * All three are read from the live environment, so the day iOS reports the
 * inset honestly the substitution stops applying by itself. No device list.
 *
 * Everything that dodges a notch, an island or a home indicator reads
 * `--nova-safe-top` / `--nova-safe-bottom` — never env() directly. index.css
 * seeds both from env() so the first paint has a value before this runs.
 */

/** Apple's two status-bar heights. Only ever used as the substitute above,
 *  chosen between by whether the device reports a home-indicator inset —
 *  every iPhone with one also has a notch or an island. */
const STATUS_BAR_INSET = 59
const STATUS_BAR_CLASSIC = 20

/** Resolve a CSS length in the live document. A hidden fixed probe is the
 *  only way to ask "what did env() come out as?" — it is not readable from
 *  JS any other way. */
function resolve(probe: HTMLElement, css: string): number {
  probe.style.height = css
  return probe.getBoundingClientRect().height
}

export function installedApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS's own flag — still the only true answer for a home-screen app
    // added before it honoured the manifest's display mode.
    (navigator as { standalone?: boolean }).standalone === true
  )
}

/** Is this app occupying the whole width of the display — i.e. is there a
 *  status bar over us at all?
 *
 *  Compared on the SHORT edge, and that is the whole point. This read the
 *  LONG edge until 2026-09-15, which made it answer "no" in exactly the case
 *  that needs a "yes": iOS gave the owner's installed app a view one status
 *  bar SHORTER than the screen and still drew it from the top edge, so the
 *  long edge fell 59px short, the substitution below was skipped, and the
 *  first line of the app was drawn under the clock. Reproduced in
 *  e2e/short-view.mjs.
 *
 *  The short edge is what actually distinguishes the case this guard was
 *  written for. A split view or a non-full-screen window loses WIDTH, and
 *  nothing is drawn over it; a full-width view keeps its short edge whether
 *  or not iOS shortened it, and something is. Short edges also survive
 *  rotation on their own, which is why the original compared long ones —
 *  iOS reports screen dimensions unrotated, so comparing min to min is
 *  orientation-proof too. */
export function coversScreen(): boolean {
  return coversRect(
    window.innerWidth,
    window.innerHeight,
    window.screen?.width ?? 0,
    window.screen?.height ?? 0,
  )
}

/** The rule itself, pure, so it is driven by tests rather than restated in
 *  them — a test that re-implements the comparison measures the test. */
export function coversRect(
  viewW: number,
  viewH: number,
  screenW: number,
  screenH: number,
): boolean {
  const screenShort = Math.min(screenW, screenH)
  if (!screenShort) return false
  return Math.min(viewW, viewH) >= screenShort - 4
}

/** An open keyboard shrinks the visual viewport and zeroes the bottom inset
 *  under itself. Re-measuring then would shorten the composer's padding and
 *  — because the viewport no longer covers the screen — retract the top
 *  substitution, so the page would jump under the status bar mid-sentence.
 *  Nothing about the notch changed; hold the last answer. */
function keyboardOpen(): boolean {
  const vv = window.visualViewport
  return !!vv && vv.height < window.innerHeight - 100
}

/** Pure: given what env() resolved to and the two environment facts, the
 *  top inset to publish. Split out so the substitution rule is testable
 *  without a real device. */
export function topInset(resolvedTop: number, resolvedBottom: number, installed: boolean, covers: boolean): number {
  if (resolvedTop > 0) return resolvedTop
  if (!installed || !covers) return 0
  return resolvedBottom > 0 ? STATUS_BAR_INSET : STATUS_BAR_CLASSIC
}

let published = false

export function measureSafeArea(): void {
  if (published && keyboardOpen()) return
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:0'
  document.body.appendChild(probe)
  try {
    const top = resolve(probe, 'env(safe-area-inset-top, 0px)')
    const bottom = resolve(probe, 'env(safe-area-inset-bottom, 0px)')
    const root = document.documentElement.style
    root.setProperty('--nova-safe-top', `${topInset(top, bottom, installedApp(), coversScreen())}px`)
    root.setProperty('--nova-safe-bottom', `${bottom}px`)
    published = true
  } finally {
    probe.remove()
  }
}

/** Publish the insets now, and again whenever the viewport changes shape
 *  (rotation, split view). Cheap: two layout reads. */
export function trackSafeArea(): void {
  measureSafeArea()
  window.addEventListener('resize', measureSafeArea)
  window.addEventListener('orientationchange', measureSafeArea)
  window.visualViewport?.addEventListener('resize', measureSafeArea)
}
