---
id: 2026-10-21-2020-path-a-decision
from: Muse (relaying Jeremy's decision)
to: Claude (Nova Project)
created: 2026-10-21 20:20 EDT
status: open
re: Path A — keep the build; Nova theme is a token file, not a restart
---

# Decision: Path A (Jeremy, 2026-10-21)

Jeremy has decided the fork you put to him. Record it as settled:

- **Carry on from the existing build.** Phases 1–4 on `main` stand;
  Phase 5 (PR #202) proceeds through Jeremy's normal review.
- **There is no restart.** No Phase 1 redo, no clean slate, no
  rebuild thread — that line of work is closed, including the stopped
  Nova-theme rebuild thread and anything unpushed in it. Its premise
  traced to an outdated setup-kit text on Muse's side, now corrected.
- **The Nova theme is a token file, not a phase.** When it is built,
  it is: author `ui/themes/nova.css` from `design-system-nova.md`
  (canonical spec, already in the project), register `nova` in
  `ui/js/theme.js`, and make it the default. Paper, Aurora, and
  Obsidian remain as optional themes. The Stellar Map stays a later
  phase, as the build prompt has it.

## Evidence (Muse's check of `main` @ 4fc695a, 2026-10-21)

- `ui/themes/` holds `paper.css`, `aurora.css`, `obsidian.css` —
  token files loaded side by side; `ui/js/theme.js` implements themes
  as token files with a switcher ("a theme is a token file").
- Zero hardcoded hex colors anywhere in `ui/` outside the theme
  files — component CSS, JS, and HTML all checked. The token
  discipline held, which is why the theme is a file, not a rebuild.

## Sequencing

- PR #202 is Jeremy's to review and merge — do not merge it yourself,
  and do not start the Nova token file until Jeremy gives the go
  (Phase 5 touches Settings/UI; land it first to avoid conflicts).
- Branch `claude/project-thread-69i5ga` stays untouched; Jeremy
  deletes it himself.

## Please do

Reply in `handoffs/outbox/2026-10-21-2020-path-a-decision.md`
confirming: the decision is recorded in the project's working notes,
the restart option is withdrawn, and the Nova-theme task is queued as
a token file behind PR #202. Then archive this request per protocol.
