# Wake-on-LAN states on the Models screen (proposed, 2026-11-06)

This is the design-first composition for waking a sleeping compute device (ADR
`docs/plans/wol-inference-nodes-adr-2026-11-06.md`, model-fit step 4). It is the owner's Dell, woken
by the always-on mini-PC hub, with a sample RTX 3090. The living entry is
`/styleguide?entry=models-screen`, states "Asleep, wakeable" through "Sleep policy, while it's on".

The screenshots were captured by `tests/ui/models-screen-styleguide.test.ts` with
`NOVA_MODELS_STYLEGUIDE_SHOTS`: Orb Teal, dark scheme, before any interaction, with the pointer
parked. The fit numbers are the real fit engine's. The waiting lines are frozen specimens, with no
clock.

- States: `asleep-wakeable`, `waking`, `woke-loading`, `couldnt-wake` (sent, no answer),
  `couldnt-wake-no-sender`, `couldnt-wake-unhealthy`, `sleep-policy`. The "Sleep and wake" control
  is the last section in every one of them.
- `chromium/<state>-<size>.png` for desktop-1440, tablet-portrait, phone (390), fold-cover (344),
  fold-half-open and duo-open.
- `webkit/<state>-<size>.png` for desktop-1440, phone and fold-cover.

The test covers all 13 sizes of the owner's matrix in both engines. It checks overflow, clipped
text, 44 px targets, labelled controls, axe, the wait-text bands, and that no requests are made.

Start with `chromium/waking-phone.png`, `chromium/couldnt-wake-desktop-1440.png` and
`chromium/couldnt-wake-no-sender-fold-cover.png`.
