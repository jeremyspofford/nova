# Health on the Duo cover screen — owner defects (2026-11-08)

Evidence: Jeremy's screenshot from the iPhone Duo FRONT (cover) screen, Health surface, filed as `nova-ui-health-duo-cover-owner-shot-2026-11-08.jpg`. Same failure family as F8/F9 (2026-10-31, Duo postures squeezed by a layout meant for wider screens), still live on the current build.

## Defects, as seen in the shot
1. **Dead column.** Content occupies only the left ~60% of the width; the right ~40% is empty black. Text wraps early ("3 / h ago" split across lines) while a third of the screen goes unused. At cover width the surface must be one full-width column.
2. **The same event three times.** "Nova's chat model (claude) answers again. A failed task is yours to retry or cancel. 3 h ago" appears three times, identically, consecutively, in "What Nova did." Identical consecutive events must collapse into one entry (with a count if the number matters).
3. **Clipped list markers.** The numbered items under "What you can do" start at the screen edge — "1." and "2." are half cut off. List markers live inside the content padding, never outside it.
4. **Floating action.** "Mark as dealt with" sits mid-screen, visually detached from whichever entry it belongs to. An action belongs inside its own card/entry, adjacent to its text.
5. **Orb still a flat red ball** in the header (F3 family; the status-icon system is the fix path — this is Health on the current build, before Part B placement).

## Gates this must pass
- Duo cover posture is in the responsive matrix and in CI shots (Chromium + WebKit baselines exist for Duo postures from the F8/F9 work). The fix PR includes a Health screenshot at the Duo cover posture, before/after, and states which existing gate failed to catch the dead column — if no gate covers cover-width Health, add the baseline; a defect that recurs becomes a permanent test.
- Text-integrity rule already on record: no text block narrower than ~8 characters per line in any posture; a 40%-empty layout at cover width violates the spirit of that rule even when lines stay long enough — width usage is part of the posture contract.
