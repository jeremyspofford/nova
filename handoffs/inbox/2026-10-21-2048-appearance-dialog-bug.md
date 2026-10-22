---
id: 2026-10-21-2048-appearance-dialog-bug
from: Muse (Jeremy's report, Muse's diagnosis)
to: Claude (Nova Project)
created: 2026-10-21 20:48 EDT
status: open
re: BUG — Appearance button dead since PR #202; duplicate `settings` key in ui/js/app.js
---

# Bug: Appearance button does nothing; themes cannot be changed

Reported by Jeremy on `main` after merging PR #202 (dev server,
current checkout). Clicking **Appearance** does nothing at all.

## Root cause (verified in the code by Muse)

In `ui/js/app.js`, the `el` object literal defines the key
`settings` **twice**:

- Line 14: `settings: $('settings')` — the Appearance
  `<dialog id="settings">` in `ui/index.html`.
- Line 20: `settings: $('settings-view')` — the Settings page
  section. **Added by commit `1aaac27` (PR #202, Phase 5).**

In a JS object literal the later key wins, so `el.settings` is the
settings-view section, not the dialog. Consequences:

- The Appearance click handler calls `el.settings.showModal()` —
  a `<section>` has no `showModal()`, so it throws a TypeError and
  the dialog never opens. The button looks dead.
- The `change` listener that applies theme/mode picks, and the
  `close` listener, are attached to the section instead of the
  dialog, so theme switching is broken even past the open step.
- The Settings page itself works (it uses the section) — which is
  why the suites stayed green while Appearance died.

## Fix shape

Give the dialog its own key (e.g. `appearanceDialog: $('settings')`)
and point the appearance handler plus the dialog's `change`/`close`
listeners at it; leave `el.settings` as the settings-view section
for the Phase 5 code. One naming, no duplicate keys.

## Regression cover (please add)

A walkthrough check that clicks Appearance, asserts the dialog
opens, switches the theme radio, and asserts `data-theme` changes.
This bug shipped under a green suite (127/127 tests, 114/114
walkthrough on the theme branch — same `app.js`), so the coverage
gap is the real defect.

## Notes

- PR #204 (Nova theme) carries the same `app.js` — it branched from
  current `main`. Land this fix as its own small PR to `main`;
  #204 can rebase on it.
- Reply in the outbox (same filename) with the fix PR and the new
  check's result, then archive this request.
