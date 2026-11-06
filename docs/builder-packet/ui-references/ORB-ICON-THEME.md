# Nova orb / icon / theme reference — owner-supplied 2026-11-06

Jeremy sent this image and said: this is like the icon he enjoys with Nova,
and probably a theme to match. Filed as the binding visual reference for
Nova's orb identity and the matching theme direction. Image:
`nova-orb-icon-reference-2026-11-06.jpg` (215×219, screenshot-grade only —
a direction reference, NOT a production asset; recreate at full resolution).

## What the image is

- A rounded-square app icon on a near-black field.
- Inside: a swirling nebula vortex — one continuous spiral of light that
  curls into a dark centre. Deep space blue and teal on one side, violet
  and magenta on the other, a warm coral/orange arc through the lower
  centre. Fine star speckles in the dark areas.
- No face, no text, no symbol, no letterform. Abstract light and motion
  only — which already complies with the settled orb rule (NO face).

## Palette (sampled from the image, approximate)

- Field / dark centre: near-black `#0E0B0F`
- Deep space blue: `#14295B` / `#163887`
- Teal-cyan: `#1684B9`
- Violet: `#62377B` / `#852BAC`
- Magenta-pink highlight: `#A35F9D` / `#E5998D`
- Warm coral-orange: `#F08D1F` / `#B34F0E`

The point is the *range*: cool blue→teal sweeping through violet/magenta
into a warm orange. A two-colour gradient is not this.

## How it maps onto settled Nova rules

- **Orb identity:** this swirl is the orb's visual language — a vortex of
  light, not a disc. Orb states stay the fixed semantic set
  (idle/listening/working/speaking/needs-you/stopped/offline) and must
  still differ by motion + brightness, not hue alone; red stays reserved
  for problems that stop Nova, amber for needs-you-but-running. Suggested
  expression: idle = slow rotation, dim; working = faster swirl, brighter;
  speaking = pulsing along the spiral; stopped = motion ceases and the
  swirl collapses/desaturates (must remain unmistakable even in
  reduced-motion form).
- **This is the space-like theme Jeremy floated on 2026-10-31**, now with a
  concrete reference. Working label only (not a decided name): Nebula.
- **One standout per view (§0/§1):** the swirl is the standout. It belongs
  to the icon, the orb, and rare identity moments — not wallpapered behind
  content.

## The line the theme must not cross

Design §0 banned the old Nova/Aurora indigo-on-black UI. This reference
does NOT reopen that: painting whole surfaces dark indigo was the failure.
A theme matching this icon means:

- Surfaces stay dark *neutral* (near-black, low saturation), so the
  swirl's colours stay special; text and chrome follow the filed UI
  references (Linear discipline, Claude.ai restraint).
- The nebula gradient appears in the orb/icon, state accents, and at most
  one identity surface per view — never as body backgrounds, card fills,
  or text colour.
- Contrast gates still apply unchanged (4.5:1 text); no colour from this
  palette is exempt.
- A light theme remains a first-class theme; this direction defines the
  dark theme and the icon, not the only way Nova can look.

## Builder use

- App icon / favicon / PWA icons: recreate this swirl at production sizes;
  do not upscale the 215px reference.
- UI rebuild compositions: the orb in shell/chat and Home compositions
  should be judged against this image, alongside the filed
  `ui-references/` set.
- Theme tokens: if a Nebula dark theme is built, derive its accent tokens
  from the palette above and file them in the living styleguide first
  (design-first rule) — no app code before the styleguide entry renders.
