Status: OWNER-SIDE DESIGN INPUT, 2026-11-01 — how Nova's design system gains an actual design (art direction, living styleguide, design-first workflow, designed values, slop gate). Builder prompt accompanies it.

# Design quality system — how Nova stops looking AI-built (2026-11-01)

Owner question (Jeremy, 2026-11-01): "How do I give Claude a way to
keep styles consistent, and the UI looking good, and not like an
application AI built? It needs like a UX designer engineer to build
it properly, with a design system specified."

## Diagnosis (verified against the repo, 2026-11-01)

Nova HAS a design system document — DESIGN-SYSTEM.md in the packet —
but it is 51 lines: a token SCHEMA (names, rules, package format,
posture rules, a component inventory) with lint enforcement (raw
values in components are lint errors). What it does not contain is
a DESIGN: no chosen visual direction (the app ships six design
packages presented as equals), no reference exemplars, no designed
values with a point of view, and no step in the build loop where
anyone plays designer. The builder invents taste screen by screen
inside those rules, which is precisely how AI-built UIs happen:
locally plausible, globally averaged. The UX review's findings are
the symptoms: a composer whose radius scales into an ellipse, an
orb rendered as a flat disc, six equal themes, density without
hierarchy.

## The fix — five mechanisms, in order

1. **Art direction, decided once.** DESIGN-SYSTEM gains a §0:
   named exemplars per surface family (chat: the restraint of the
   best conversational UIs; control surfaces — Home, Tasks,
   Health, Activity: Linear/Raycast-class density and crispness;
   Settings: macOS Settings / Raycast settings clarity) and named
   ANTI-references (generic SaaS dashboard, stock Tailwind/shadcn
   look, purple-gradient AI aesthetic, card-grid monotony, emoji
   as icons). ONE lead package (Orb Teal) is perfected first;
   other packages inherit its structure and only re-express
   values. Six equal packages is a launch liability, not a
   feature: depth in one beats breadth in six.

2. **A living styleguide as the contract.** A /styleguide route in
   the app rendering EVERY component in EVERY state with real
   Nova content (not lorem). It becomes the single visual truth:
   if it is not in the styleguide, it does not ship.

3. **Design-first workflow for new surfaces.** For any new surface
   or component, the builder's FIRST deliverable is the styleguide
   entry (rendered, screenshot-able) — the design pass, separate
   from the engineering pass. The owner approves the rendered
   styleguide (recognition, ~a minute per surface — he has proven
   he spots wrongness instantly from screenshots). Only then does
   app code get written, composing ONLY styleguide components;
   the PR's screenshots must match the styleguide rendering.

4. **Designed values, not default values.** The token VALUES get
   an actual design pass: a 4pt-based spacing scale with named
   steps and no off-scale values; a ratio-based type scale with
   a real hierarchy (the AI tell is everything the same weight);
   at most two elevation/shadow levels; radius steps bound to
   component size class, never to rendered height (the composer
   ellipse); motion tokens (durations + easings, one family);
   a single icon set at a single stroke weight.

5. **The slop check, in the gate.** Every UI PR: posture-matrix
   screenshots (already required by the fold work) PLUS a
   self-check against a written AI-slop list in DESIGN-SYSTEM
   (uniform card grids with equal weight; everything centered;
   gradient decoration; more than one standout per view; type
   hierarchy flatter than the scale; off-scale spacing; mixed
   icon styles; placeholder-looking empty states). The owner-side
   UX review skill scores the same list independently.

## What this asks of the owner

One decision up front (the exemplar set in mechanism 1 — proposed
above, he can amend) and ~one minute per new surface at the
styleguide stage thereafter. That is the entire taste gate. The
reason this works when prose specs don't: every consistency
question gets answered by comparing RENDERED ARTIFACTS (styleguide
vs PR screenshot), never by arguing from descriptions.

Status: owner-approved direction requested 2026-11-01; builder
prompt accompanies this note.
