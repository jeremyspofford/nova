# Owner direction: ONE mark — the supernova N (2026-11-08, supersedes the multi-shape icon mapping)

Jeremy, after reviewing the shipped multi-shape states (PR #381): he is not a fan of the different-shaped icons and is returning to his ORIGINAL request — a single mark for Nova:

- **The mark:** an **N for Nova** rendered like a supernova / black hole: **black in the middle** (the dark core), the **colours form the N** (nebula ribbons as the letter's strokes — two uprights and the diagonal as swirling accretion flow around the black centre).
- **States change colour and animation, never the shape.** One mark everywhere; a state is a palette shift plus a motion behaviour (speed, pulse, stillness) plus brightness. The X, triangle, check, pillars, crescent and the rest of the sheet's shape zoo are retired — Jeremy on the X: "looks like two mitochondria and I hate it."

## State expression on the single mark (palette + motion + brightness)
- idle: full nebula palette, very slow swirl, calm brightness
- listening: cyan-leaning palette, slow inward pulse
- thinking: palette churns/shifts internally, medium motion
- working: full palette, motion speeds up, brighter
- speaking: full palette, gentle outward pulse
- needs-you: amber palette, motion continues (needs you, but running)
- success: bright sweep across the N, ~1s, settles back to idle palette (transient only)
- paused: palette dims, motion frozen
- stopped: red palette, motion frozen — stillness plus red is the signal
- offline: greyscale, dim, frozen

## What this supersedes, and what survives
- SUPERSEDED: the per-state shape mapping in `nova-agent-status-icon-builder-prompt-2026-11-08.md` and the v2 shape-fix list (idle diagonal, listening ring, stopped X mass — all moot; there is one shape now).
- SURVIVES: the canonical state set and names; red reserved for stopped, amber for needs-you; the component API (status + size); placement rules; accessible labels per state; reduced-motion = static frames (palette + brightness still carry the state); the styleguide + screenshot acceptance rule; the Jarvis theme (which was already one form — the ring — changing behaviour; it now matches the owner's philosophy exactly).
- Noted trade-off, owner's call: with one shape, greyscale-only distinction is weaker than shape-coding was. Motion, brightness, the reserved red/amber, and the text label that accompanies status in the UI carry it. The Oct 31 rule "not hue alone" is honoured via motion + brightness, not hue by itself.

## Build order
Design-first, as always: static compositions of the ONE mark first (the N itself, at 16/24/48/96px, in idle palette), owner reaction, then the palette/motion table animated. The mark has to be right as a still before any animation work — it is also the app icon, so this is the brand decision, not an icon detail.
