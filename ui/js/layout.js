// Which layout to show, from the viewport and the device's posture (DESIGN-SYSTEM §5), never
// from a device name. The widths themselves live only in ui/styles/layout.css: it sets
// --viewport (narrow | medium | wide), --aside-room (yes | no) and --segments (none |
// horizontal | vertical) on :root, and this module turns those, plus the posture, into
// <body data-layout data-posture data-aside>. These functions are pure, so they are unit-tested.

export const LAYOUTS = Object.freeze(['phone', 'tablet', 'desktop']);

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

// The second column of quiet cards: always the context pane on a tablet; on a desktop, only
// when there is room, unless the person closed it; never on a phone.
export function asideOf({ layout, room = 'no', closed = false }) {
  if (layout === 'tablet') return 'on';
  return layout === 'desktop' && room === 'yes' && !closed ? 'on' : 'off';
}

// Everything at once, for <body>.
export function resolve({ viewport, room, segments, devicePosture, orientation, override, closed }) {
  const posture = postureOf({ override, segments, devicePosture, orientation });
  const layout = layoutOf({ viewport, posture });
  return { layout, posture, aside: asideOf({ layout, room, closed }) };
}
