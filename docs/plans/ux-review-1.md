# UX review 1: the fixes (F0–F5), with before and after

**Source:** the owner-approved fix list from the first UX review of the preview (2026-10-31),
findings F0–F7, with evidence in `~/workspace/nova-qa/evidence/ux-review-2026-10-31/`
(screenshots and `metrics.json`). One PR, in the owner's order: F0, F1, F3, F2, F5, F4. F6 and F7
are a second pass: noted below, not built.

**How it was measured:** the same way the review measured, in the Playwright container
(`scripts/ui-test.sh`), against a seeded profile like the review's (a conversation with tables, a
step that links out to Gmail, memory held at the ingest gate, an open problem): `tests/ui/ux-review-1.test.ts`
prints every number below (`UX1 …` lines), before the fix (on `origin/main` at `33cef8a9`) and after.
The axe counts come from `tests/ui/axe-advisory.ts`: axe-core 4.14.0 (the version the review's
harness had installed), `axe.run()` with its default rules, the review's nine views at its ten
postures.

## F0: the composer keeps its shape

**Cause.** The composer is drawn with `radius/pill` (999px), which a browser scales to half the
box's height, so a grown composer is an ellipse; its text field could grow to 40% of the viewport.

**Fix.** Past one line the composer takes `radius/input` (a class set where the field is sized);
one line stays a pill. The field is capped at 25% of the viewport (`25dvh`), the composer about 27%;
past it the field scrolls inside. Padding doesn't depend on the radius. Send and the microphone stay
at its foot.

**Test.** `F0` in `tests/ui/ux-review-1.test.ts` types the review's 1, 5 and 20 lines at 1280×820 and
390×844 and asserts the cap (≤ 30%), the radius (the input token once grown), that the text starts
inside the curve, that Send and the microphone are in view, that the composer covers none of the
conversation and leaves it at least 40% of the screen, and that 20 lines scroll inside.

| 1280×820 | 1 line | 5 lines | 20 lines |
|---|---|---|---|
| height, before → after | 62 → 62 px (7.6%) | 274 → 223 px (33.4% → 27.2%) | 346 → 223 px (42.2% → 27.2%) |
| radius drawn | 31 → 31 px (a pill) | 137 → 14 px | 173 → 14 px |
| how far the curve cuts in, against where the text starts (25 px in, 9 px down) | 9 → 9 px | 40 → 4 px | 51 → 4 px |
| conversation left on screen | 618 → 618 px | 406 → 457 px | 334 → 457 px |
| composer over the conversation | 0 → 0 px | 0 → 0 px | 0 → 0 px |

| 390×844 (phone) | 1 line | 5 lines | 20 lines |
|---|---|---|---|
| height | 62 → 62 px (7.3%) | 356 → 229 px (42.1% → 27.1%) | 356 → 229 px (42.1% → 27.1%) |
| radius drawn | 31 → 31 px | 164 → 14 px | 164 → 14 px |
| conversation left on screen | 572 → 572 px | 278 → 405 px | 278 → 405 px |

The heights before match the review's own (its 44/256/328 px is the text field; the composer adds
18 px). "Overlap" was never a box over the conversation (the composer sits below the scroller); it
was the ellipse: at 5 and 20 lines its curve cut 40–51 px into a field whose text starts 9 px down,
so the first lines slid under the curve and out past the drawn edge. Now the curve cuts 4 px.

## F1: the Health card says what's wrong in human terms

**Cause.** The card quoted the first open problem's own message, which can name a file
(`workspace/screenpipe-snapshot/index.sqlite-wal is larger than 8 MB, …`).

**Fix.** The card says how many problems and what they are about, from where each came from ("About
the standby’s copy of your files.", "Both are about …", "About backups and a task that failed."), then
"What happened, and what you can do, is in Health." A failing check with no problem names the check,
never its detail. Health itself is unchanged: the full message, the playbook and the technical detail
one tap away.

**Test.** `tests/ui-components.test.js` (the review's own message, two in one area, mixed areas, a
failing check); `F1` in `tests/ui/ux-review-1.test.ts` (Home and Tasks show no path, file name or
stack, and don't repeat the message; Health does show it).

Before: "1 problem to look at · A task failed: Backup now. Backups couldn't do it: The backup folder…"
(the review's: "2 problems to look at · workspace/screenpipe-snapshot/index.sqlite-wal is larger than
8 MB, so the standby…"). After: "1 problem to look at · About a task that failed. · What happened, and
what you can do, is in Health." (the review's case: "2 problems to look at · Both are about the
standby’s copy of your files.").

## F3: the orb

**The colour, first.** The salmon disc was the **alert** state, not attention. `orbState()` turns
the orb to `alert` whenever any problem is open, and alert is drawn in `status/error`, which in
Orb Teal is `#ff9f96`: salmon. Health had two open problems during the review (the standby-copy size
problems), so every view showed alert. The mapping did what it says; whether an open problem of that
kind should be red at all is a question for the owner (below).

**Cause of the flatness.** In alert and attention the core's highlight colour was set to the core
colour, so its gradient ran from one colour to itself; and in every state the core's edge was
partly transparent, so on a light page the far edge was lighter than the middle (no shade at all)
and on a dark page the only "depth" was the page showing through. Offline had almost no glow.

**Fix.** The same four layers (no new parts, no features), in every state and design system, from
the state's own colours only: a glow with a soft falloff past the disc; a core lit from the upper
left whose far side is its own colour turned down (a darkening layer, never the page), with a rim of
light at the edge; a highlight that is the state's colour brightened. Offline is the same sphere,
grey and dimmed, with a faint still glow.

**Test.** `F3` in `tests/ui/ux-review-1.test.ts` screenshots the rail-sized orb in all seven states,
in all six design systems, light and dark, and measures it: highlight (lit side over the middle,
luminance 0–1), shade (middle over the far edge), and glow just outside the disc against further out.
Minimum over every design system and mode, before → after:

| state | highlight | shade | glow near / out |
|---|---|---|---|
| idle | 0.087 → 0.148 | −0.082 → 0.106 | 0.103 / 0.037 → 0.178 / 0.066 |
| listening | 0.037 → 0.072 | −0.055 → 0.089 | 0.103 / 0.037 → 0.178 / 0.066 |
| working | 0.087 → 0.148 | −0.082 → 0.105 | 0.103 / 0.037 → 0.178 / 0.064 |
| speaking | 0.058 → 0.089 | −0.072 → 0.122 | 0.116 / 0.055 → 0.211 / 0.092 |
| attention | 0.093 → 0.174 | −0.057 → 0.116 | 0.131 / 0.049 → 0.221 / 0.083 |
| alert | 0.017 → 0.098 | −0.089 → 0.061 | 0.150 / 0.050 → 0.248 / 0.083 |
| offline | 0.039 → 0.101 | −0.044 → 0.075 | 0.010 / 0.000 → 0.056 / 0.017 |

(Orb Teal's alert, the review's case: shade 0.067 → 0.225, glow 0.186 → 0.307.)

## F2: one rule for the rail

**Cause.** Rail items were as wide as their label, with a 52 px minimum, so "Automations" made its
item 74–75 px in a 72–76 px rail: past the edge in Nova and Aurora (72 px), touching it in Orb Teal.

**Decision (one rule for every rail item).** Each rail item is the rail's width less `space/1` on
each side, and its label wraps inside it (hyphenating where the browser can, breaking anywhere as a
last resort), so no label can reach past the rail however long it gets. The rail
(`layout/rail-width`) is 84 px in every built-in design system (was 72 or 76), so today's labels sit
on one line.

**Test.** `F2` in `tests/ui/ux-review-1.test.ts`, at laptop, desktop and tablet widths, in all six
design systems: every item inside the rail, every label inside its item, then again with a label
longer than any today ("Housekeeping and automations").

Before: rail 76 / 72 px, items 74–75 px, overflowing in Nova and Aurora. After: rail 84 px, every
item 76 px, nothing overflows, the long label wraps inside.

## F5: accessibility (axe)

**Causes and fixes.**
- `landmark-unique`: each table's scroll box was a region named "Table", each turn's margin notes a
  complementary landmark ("Kept in memory"), and Settings named a pane and its part the same ("You
  and Nova"). Now: a table's box is a group named by its columns ("Table: Monday, Tuesday"), margin
  notes are notes, and a Settings pane is a plain section.
- `empty-table-header`: a Markdown table with an empty first header cell (a row-label column). That
  cell is now a plain cell.
- `nested-interactive`: a step's "Open in Gmail" link sat inside its `<summary>`. It now sits beside
  it (and below the output when that is open).
- `empty-heading` and `page-has-heading-one` on Home: the page heading was empty on Home, and the
  phone's Home hid the whole top bar. Home's heading says "Home" (for screen readers; it isn't shown),
  and the phone's top bar folds to nothing instead of being removed.

**The advisory.** `npm run ui:axe` (`tests/ui/axe-advisory.ts`) runs the sweep and writes the table
to the CI job summary. It runs in the UI gate's Playwright container after the gate's own tests, with
`continue-on-error`, and the script always exits 0: it never fails the job or `gate`. Locally:
`scripts/ui-test.sh tests/ui/axe-advisory.ts`. It needs `axe-core` as a pinned devDependency
(4.14.0, MPL-2.0, no dependencies of its own); nothing at run time uses it.

**Counts** (nodes in violation, 9 views × 10 postures):

| rule | review (preview data) | before (seeded) | after |
|---|---|---|---|
| landmark-unique | 35 | 25 | 0 |
| empty-table-header | 20 | 30 | 0 |
| empty-heading | 10 | 6 | 0 |
| nested-interactive | 10 | 30 | 0 |
| page-has-heading-one | 0 | 4 | 0 |
| **total** | **75** | **95** | **0** |

Per view, before → after: `/` 10 → 0, `/chat` 80 → 0, `/settings` 5 → 0; every other view 0 → 0.
The seeded profile has three tables, three linked steps and held memory in every turn, so its
counts differ from the review's; the rules are the same. (`page-has-heading-one` showed only at
phone sizes on a Home without capture running; the review's preview was capturing.)

## F4: a status line twice

**Did the event fire twice?** No. A reply that has read something from outside and asks to keep two
things records **one** `memory` event holding two held candidates (here, a `remember` and a `note`),
each its own entry waiting in Memory; the chat drew one identical line per candidate.
`tests/ingest/held-once.test.js` reproduces it end to end (one event, two candidates, one line). The
review's own log wasn't read (the preview's home is off limits); its screenshot shows both lines in
one margin block, which is what one event with two held candidates draws.

**Fix.** Identical status lines one after another show once; held memory says how many ("2 things
waiting for your OK: they came after reading something from outside"); two margin blocks in a row
that say the same show once. Different lines, or the same line apart, all stay.
`tests/ux-review-1.test.js` covers the rendering.

## Second pass (noted, not built)

- **F6, tap targets** on /chat, /capture and /activity: the review counted controls under 44×44 at
  touch postures (for example 40 on /activity and 66 on /capture at duo-halfopen). Triage which are
  real targets (links inside text are exempt) before changing any.
- **F7, the right column on /tasks** repeats the "Nova is handling" card that the Tasks page itself
  is: suppress a right-column card when the page shows the same thing.

## NOTES for Track 1

**What changed (2026-10-31, PR #254, UX review 1):**
- Typing a long message no longer turns the chat box into a big oval that hides your text: it stays a
  rounded box, never taller than about a quarter of the screen, and scrolls inside.
- The System health card says what's wrong in plain words ("About the standby’s copy of your
  files"); the file names and technical detail are on the Health page.
- The orb looks like a lit, glowing sphere in every state and design. It was salmon in the review
  because Health had open problems: that is the "something went wrong" colour.
- Rail labels such as "Automations" stay inside the rail in every design; the rail is a little wider.
- Accessibility problems the review found are fixed (75 → 0 on its checks), and every pull request
  now shows these checks as a report that never blocks it. A repeated "waiting for your OK" line now
  shows once, with how many.
- Still unfinished: tap-target sizes (F6) and the repeated card on Tasks (F7).

**Decision for the LEDGER (owner to confirm):** any open problem turns the orb to the alert colour
(`status/error`, red family). DESIGN-SYSTEM §1 says "red only for real alerts". The review's two
problems (files too large for the standby's copy) were real but not urgent. Proposed: keep alert for
problems that stop Nova doing something, and show amber "needs you" for problems that only want a
look. Not changed in this PR.

**Decision recorded:** rail items follow one rule (the rail's width less a margin, labels wrap
inside); `layout/rail-width` is 84 px in every built-in design system.
