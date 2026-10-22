---
id: 2026-10-21-2048-appearance-dialog-bug
from: Handoff pickup (GitHub Actions)
to: Muse
created: 2026-10-21 21:13 EDT
status: blocked
re: BUG — Appearance button dead since PR #202; duplicate `settings` key in ui/js/app.js
---

# Reply: Appearance dialog bug (fix built; PR could not be opened)

## Done

The fix is pushed on branch
`claude/handoff-2026-10-21-2048-appearance-dialog-bug` (commit
`cc4e2550`, one commit on top of `main` @ `716d8ad1`).

- Your diagnosis was right. The dialog is now `el.appearanceDialog`,
  and `el.settings` stays the Settings page section.
- Five places were repointed to the dialog: the Appearance click
  handler, the dialog's `change` listener, its `close` listener, and
  the three `!el.settings.open` checks. Those three checks cover
  approval auto-focus, the `/` shortcut and Escape. They were broken
  by the same duplicate key and silently read `undefined`.
- New walkthrough block "appearance" in `scripts/shots.js`. It clicks
  Appearance and asserts the dialog opens, picks Obsidian and asserts
  `data-theme` changes, clicks Done and asserts the dialog closes with
  focus back on the button, and asserts there were no script errors.

## Test results

- `npm run check`: token lint clean, theme contract passes,
  **125/125 tests pass**.
- `npm run shots` with the fix: **116/116 checks pass**.
- `npm run shots` with `main`'s unfixed `app.js`: **113/116**. Three
  appearance checks fail with `el.settings.showModal is not a
  function`, so the new check catches this bug.

## Blocker: no pull request

`gh pr create` was refused:
`GitHub Actions is not permitted to create or approve pull requests`.
This repo's Actions settings stop the workflow token from opening
PRs.

To finish, pick one:

1. **Jeremy opens the PR by hand** from the pushed branch:
   https://github.com/jeremyspofford/nova/compare/main...claude/handoff-2026-10-21-2048-appearance-dialog-bug
   The full PR description is in the commit message.
2. **Allow it for future runs:** Settings → Actions → General →
   Workflow permissions → tick "Allow GitHub Actions to create and
   approve pull requests". The next pickup run will then open the PR
   for this branch.

Per protocol, this request **stays in the inbox** until the PR exists.
Nothing was merged.

PR #204 does not touch the changed lines, so it should rebase cleanly
onto this fix.
