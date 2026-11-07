# Models on a device: a tight plan waits for your acknowledgement (2026-11-06)

The app's Settings › Devices › [device] › Models with a tight plan: `qwen3:32b` at Q4_K_M with 4k context on the 24 GB card, which leaves less than a tenth of the budget free. The owner decided on 2026-11-06 that Nova never picks a Tight model for you; the plan shows the acknowledgement box next to Install and assign, unticked, and Install stays off until it is ticked. The recommendation for general chat beside it is 14B at Q8_0, which fits comfortably. Same layout as `docs/screenshots/models-screen-app-2026-11-05/`. Captured by `tests/ui/models-screen-app.test.ts` with `NOVA_MODELS_APP_SHOTS` (state `tight-ack`), Orb Teal, dark scheme, against the real server, the stand-in Ollama and fixed hardware readings; the plan was made with the screen's own controls.

- `chromium/tight-ack-<size>.png` for desktop-1440 and phone (390)
- `webkit/tight-ack-<size>.png` for desktop-1440 and phone

The same state is in the styleguide (`/styleguide?entry=models-screen`, state "A tight plan: Install waits for your acknowledgement"). Both are checked at all 13 sizes of the owner's matrix in both engines: no horizontal scroll, no clipped text, nothing outside the panel, 44 px targets (the box included), labelled controls, and axe at phone, desktop-1440 and fold-cover.
