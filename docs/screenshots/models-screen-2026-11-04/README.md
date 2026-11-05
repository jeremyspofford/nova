# Models on a device (proposed, 2026-11-04)

Design-first composition for the per-device Models screen (ADR `docs/plans/model-fit-adr-2026-11-04.md`, step 3). Living entry: `/styleguide?entry=models-screen`. Captured by `tests/ui/models-screen-styleguide.test.ts` with `NOVA_MODELS_STYLEGUIDE_SHOTS`, Orb Teal, dark scheme, before any interaction, pointer parked. Every verdict and number is the real fit engine's (`ui/js/fit-engine.js` is `src/core/models/fit.ts` with its types erased).

- States: `3090-one-model`, `3090-two-models`, `8gb-nothing-at-16k`, `mac-16gb-unified`, `unknown-shape`, `no-gpu`
- `chromium/<state>-<size>.png` for desktop-1440, tablet-portrait, phone (390), fold-cover (344), fold-half-open and duo-open
- `webkit/<state>-<size>.png` for desktop-1440, phone and fold-cover

The test covers all 13 sizes of the owner's matrix (desktop 1920/1440/1280, iPad portrait and landscape, phones 390/430/412, fold cover, fold open, fold half-open, Pixel Fold open, Duo open) in both engines: overflow, clipped text, 44px targets, labelled controls, axe, and no requests. The other 60 raw captures are kept privately.

Start with `chromium/3090-two-models-desktop-1440.png`, `chromium/8gb-nothing-at-16k-phone.png` and `chromium/8gb-nothing-at-16k-fold-cover.png`.
