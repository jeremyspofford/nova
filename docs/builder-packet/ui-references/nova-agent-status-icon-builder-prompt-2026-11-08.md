# Agent status icon system — builder prompt (2026-11-08)

For Jeremy: this is ChatGPT's prompt, corrected against Nova's settled rules before it goes to Claude. What changed and why:

1. **State names remapped to Nova's canonical set.** ChatGPT invented its own eight (idle/working/thinking/success/warning/error/paused/offline). Nova already has a fixed semantic set (idle/listening/working/speaking/needs-you/stopped/offline). The prompt below maps the sheet's forms onto Nova's states, adds "thinking" as a sub-state of working, "paused" as a new state, and "success" as a transient flourish only — not a resting state.
2. **Colour discipline added.** Red is reserved for problems that STOP Nova. Amber = needs-you-but-running. States must differ by shape AND motion/brightness, never hue alone (already in the prompt, now tied to the canonical states).
3. **Placement limits added.** ChatGPT said "integrate wherever the app shows agent status." Nova's rule is one orb per view, never a per-message avatar. The prompt limits placements to rail, header, and agent/task rows.
4. **The Gemini collage is reference-with-exclusions.** Its hero swirl is the same family as the Nov 6 orb icon, but the literal objects (gear, crystals, cracked glass, the green "eye" success centre) are explicitly excluded — Nova's forms stay abstract, no face, no symbols baked in.
5. **Acceptance made checkable.** A styleguide entry + preview route + screenshots are the deliverable; the PR is not done without them. This is the part whose absence is why earlier icon instructions evaporated.

Filed alongside: `nova-agent-state-system-sheet-2026-11-08.jpg` (the 8-state sheet) and `nova-agent-state-gemini-collage-2026-11-08.jpg`, both also copied into the builder packet at `docs/builder-packet/ui-references/`.

Jeremy pastes only the block below.

---

```
AGENT STATUS ICON SYSTEM — build this as one queue item, design-first.

REFERENCES (read before any code)
- docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg — the binding art direction: dark rounded tiles, one sculptural iridescent ribbon material (blue/cyan/violet/orange) reshaped per state, with transition strips showing the forms morphing into each other.
- docs/builder-packet/ui-references/nova-agent-state-gemini-collage-2026-11-08.jpg — supporting reference for the hero swirl ONLY. Excluded from that sheet: the gear, the crystals, the cracked-glass error, and the green eye-like success centre. No literal objects, no symbols, no face — abstract light and form only.
- docs/builder-packet/ui-references/ORB-ICON-THEME.md — palette and guardrails already in force.

CANONICAL STATES — Nova's set governs; the sheet's forms map onto it exactly like this:
- idle → the sheet's IDLE swirl
- listening → the sheet's WORKING orbit ring, slowed, cyan-leaning (an open ring = receiving)
- thinking → the sheet's THINKING spiral (sub-state of working: shown while the model is reasoning)
- working → the same spiral family in motion while tools execute; thinking/working are distinguished by motion, and the component API accepts both
- speaking → the IDLE swirl form with an outward pulse; no separate glyph
- needs-you → the sheet's WARNING triangle, amber. Amber means needs-you-but-running, always
- success → the sheet's SUCCESS wave/check form, TRANSIENT ONLY: a brief flourish (~1s) that settles back to idle; never a resting state, and render it in the nebula palette, not green
- paused → the sheet's PAUSED twin pillars (user-paused; not an error, no red/amber)
- stopped → the sheet's ERROR crossed form, red. Red is reserved for problems that stop Nova — nothing else in the app may use this treatment
- offline → the sheet's OFFLINE form: same swirl, desaturated and dim

COMPONENT
- One reusable component: props = status + size. Form morphs between states over ~400ms; a status change mid-transition retargets smoothly, never jumps or restarts.
- Working/thinking loop subtly; success flourishes then settles; stopped briefly reacts then stays readable.
- Rendering approach is your call (SVG, canvas, or WebGL) — but the references are shaded, continuous forms, and flat SVG paths will not hold the material. Prefer a small shader/canvas renderer with the shared nebula gradient; keep it dependency-light and 60fps. If the full material can't be held at small sizes, ship a simplified small-size variant (same silhouette + palette, less internal detail) for sizes ≤24px rather than shrinking the detailed render into mush.
- Every state distinguishable by shape as well as colour, and legible at 16px, 24px, and 48px.
- Accessible label per state (aria-label / title from the canonical state name). prefers-reduced-motion: no looping, no morph — instant swap to a static frame per state that stays distinguishable by shape and brightness.

PLACEMENT — obey the existing rule: one standout per view
- Rail, app header, and agent/task rows may use the component.
- NEVER as a per-message avatar in chat, and never more than one hero-size instance per view.

DELIVERABLES — the PR is not done without all of these
1. A /styleguide entry for the component (not in the styleguide = doesn't ship).
2. A preview surface showing all states at 16/24/48px plus controls to trigger transitions, including a mid-transition state change and a reduced-motion toggle.
3. Screenshots of the preview at desktop and phone postures, posted in the PR — screenshots are the acceptance artifact; a description is not.
4. Integration in the placements above, behind the existing design-system tokens (Nebula expresses these forms natively; other themes map the same canonical states onto their own forms per the design-system contract).

Report back: PR number, the screenshot set, your renderer choice in one line, and any state whose form you could not hold at 16px and what you did instead. Then continue the queue.
```
