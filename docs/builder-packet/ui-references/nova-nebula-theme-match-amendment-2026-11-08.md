# Nebula theme — match the agent status icon material + default (2026-11-08)

Jeremy's ask (2026-11-08): a theme that matches the new agent status icon system, and it must be the default theme.

## What is already true
- PR #376 (merged 2026-11-08 09:57 ET) already made **Nebula the default design system** — but only as the *no-pick fallback*: profiles that already selected a design keep theirs. If Jeremy's preview profile has a stored pick, the default change does not change what he sees. That must be checked, not assumed.
- The Nov 6 orb icon reference (filed, palette sampled) is the same material family as the Nov 8 state sheet. Nebula exists as a design system; what has not happened is expressing the sheet's material in Nebula's surface tokens as one coherent look.

## The amendment (what "matches" means, precisely)
1. **One material everywhere it appears.** The status icons, the orb, and the app icon share the sheet's nebula ribbon material and palette (field #0E0B0F; blues #14295B/#163887; teal #1684B9; violet #62377B/#852BAC; magenta #A35F9D/#E5998D; coral #F08D1F — sampled approximations; builder samples the filed sheets directly for token values).
2. **Surfaces stay disciplined.** App surfaces are dark neutral, near the icon tile's near-black — the nebula gradient is reserved for identity/state accents (orb, status icons, the one standout element per view). This does NOT reopen gradient-washed or indigo-on-black surfaces; contrast gates (4.5:1) unchanged; the light theme remains first-class and maps the same canonical states onto its own expression.
3. **Tile language echoes.** Card/tile radius and the soft inner-glow edge from the sheet's tiles may inform Nebula's card treatment — restraint first: hairlines and spacing do the hierarchy work (Linear/Things references still govern layout).
4. **Default means default.** Nebula-with-this-material is the design a fresh profile gets, the fallback when a design is removed, and the recommended pick in the Appearance picker (not one of six equals — the §1 perception rule already calls this gap out).
5. **Proof, not prose.** The styleguide must show the theme and the status icons on the same page, screenshotted at desktop + phone, before this counts as done — same acceptance rule as the icon PR.

## Open check for the builder
Report which design the **preview home's** profile has stored as selected. If it is not Nebula, say so in one line — that alone would explain "no visible change" reports.

## Graph view
Jeremy (2026-11-08) also wants a graph view of everything about Nova — explicitly NOT now: to be specced and talked out first. Existing threads it must reconcile with when specced: Stellar Map (Nova-theme-only; PR #207 is Jeremy's own draft, untouched), the SQLite graph layer (graph addendum, 2026-11-03), Topology, and the reopened 3D immersive graph item from the ML/NN session (2026-11-06). Nothing goes to the builder before that design conversation.
