# Models on a device, as built (2026-11-05)

The app's Settings › Devices › [device] › Models, built from the approved composition (`docs/screenshots/models-screen-2026-11-04/`, PR #326), for side-by-side comparison. Same layout as the design folder. Captured by `tests/ui/models-screen-app.test.ts` with `NOVA_MODELS_APP_SHOTS`, Orb Teal, dark scheme, against the real server, the stand-in Ollama and fixed hardware readings. Each plan was made with the screen's own controls.

- States: the design's six (`3090-one-model`, `3090-two-models`, `8gb-nothing-at-16k`, `mac-16gb-unified`, `unknown-shape`, `no-gpu`), plus `asleep` (a paired computer asleep for three hours, showing what it last reported)
- `chromium/<state>-<size>.png` for desktop-1440, tablet-portrait, phone (390), fold-cover (344), fold-half-open and duo-open
- `webkit/<state>-<size>.png` for desktop-1440, phone and fold-cover

Where the build differs from the design, and why:

- The hardware is the stand-in's ("Example GPU 24GB"), and the hub's own name, not "Study desktop".
- The recommendations are from the real catalog and what the stand-in Ollama has installed. The design's catalog left out the small models (`qwen3:4b`, `llama3.2:3b`) on the 8 GB card, so its coding row said nothing fits at 16k; with them, the engine picks `qwen3:4b` at 16k. The plan row for 8B at 16k still says it won't fit, and fits up to 6k.
- The stand-in's installed models report no shape, so they are labelled as estimates, as a real model with no metadata would be.
- A "Devices" back button sits above the panel, since the screen opens in the Devices pane.

The test checks all 13 sizes of the owner's matrix in both engines (no horizontal scroll, no clipped text, nothing outside the panel, 44 px targets, labelled controls, and axe at phone, desktop-1440 and fold-cover).
