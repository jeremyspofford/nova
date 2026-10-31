// Which layout to show, from the viewport and the device's posture (DESIGN-SYSTEM §5), never
// from a device name. The widths themselves live only in ui/styles/layout.css: it derives
// --band-two and --band-three from the regions' minimums (UX review 2026-10-31, F8/F9) and sets
// --segments (none | horizontal | vertical) on :root; shell.js measures the bands, and this
// module turns the width, the bands and the posture into <body data-layout data-posture
// data-aside>. These functions are pure, so they are unit-tested.

export const LAYOUTS = Object.freeze(['phone', 'tablet', 'desktop']);

// The band a width is in, from the derived widths in px: narrow (one column), medium (the rail
// and one column), wide (the three-column band: rail, centre and right column all at their
// minimums or more). Never a round number: the bands are where the regions fit.
export function viewportOf(width, { two, three }) {
  if (width >= three) return 'wide';
  if (width >= two) return 'medium';
  return 'narrow';
}

// Postures, in Nova's words:
//   continuous            a flat screen, or a foldable fully open (the default);
//   folded                a foldable closed, used on its cover screen: a glance view;
//   half-open-horizontal  two viewport segments side by side (book posture);
//   half-open-vertical    two viewport segments stacked, one above the other (laptop posture).
// The browser's Device Posture API says "folded" for any half-open device; Nova calls that
// half-open and keeps "folded" for the cover screen, which a browser sees as a narrow viewport.
export const POSTURES = Object.freeze(['continuous', 'folded', 'half-open-horizontal', 'half-open-vertical']);

// The posture from what the browser reports. `override` is the ?posture= test hook.
export function postureOf({ override = null, segments = 'none', devicePosture = 'continuous', orientation = 'portrait' } = {}) {
  if (override && POSTURES.includes(override)) return override;
  if (segments === 'horizontal') return 'half-open-horizontal';
  if (segments === 'vertical') return 'half-open-vertical';
  // Half-open without segments reported: held landscape, the hinge runs across (laptop posture).
  if (devicePosture === 'folded') return String(orientation).startsWith('landscape') ? 'half-open-vertical' : 'half-open-horizontal';
  return 'continuous';
}

// phone: narrow, or a folded cover screen. tablet: medium, or any half-open posture (two
// segments). desktop: wide and flat.
export function layoutOf({ viewport = 'narrow', posture = 'continuous' } = {}) {
  if (posture === 'folded') return 'phone';
  if (posture.startsWith('half-open')) return 'tablet';
  if (viewport === 'wide') return 'desktop';
  if (viewport === 'medium') return 'tablet';
  return 'phone';
}

// The second column of quiet cards: on a desktop, when there is room, unless the person closed
// it; on a half-open tablet, the second pane its posture gives (beside the conversation where
// both fit, below it otherwise); never on a flat tablet, which is under the three-column band
// (its cards are on Home), and never on a phone.
export function asideOf({ layout, posture = 'continuous', room = 'no', closed = false }) {
  if (layout === 'tablet') return posture.startsWith('half-open') ? 'on' : 'off';
  return layout === 'desktop' && room === 'yes' && !closed ? 'on' : 'off';
}

// Everything at once, for <body>.
export function resolve({ viewport, room, segments, devicePosture, orientation, override, closed }) {
  const posture = postureOf({ override, segments, devicePosture, orientation });
  const layout = layoutOf({ viewport, posture });
  return { layout, posture, aside: asideOf({ layout, posture, room, closed }) };
}
