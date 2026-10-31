Status: OWNER-SIDE UX REVIEW, first run 2026-10-31 (nova-ux-review skill), findings F0-F9 with evidence in ~/workspace/nova-qa/evidence/ux-review-2026-10-31/. The fix list is owner-approved; see the accompanying consolidated prompt.

# Nova UX Review — 2026-10-31 (first run of the nova-ux-review skill)

Target: the live preview (latest main) on the Dell. Method: automated
pass over 9 views × 10 device postures (90 combinations, headless
Chromium via the nova-qa Playwright stack) + visual inspection of
home/chat/tasks/settings at desktop-1920, iphone, duo-cover,
duo-inner. Evidence: screenshots + metrics in nova-qa/evidence/
ux-review-2026-10-31/ on the XPS. Scores are 0–4 per the skill
rubric; no previous run to compare against.

## Scores

| # | Category | Score | One-line basis |
|---|---|---|---|
| 1 | First-session value | 2 | Populated home with real content; fresh-user path not exercised in this run |
| 2 | Visibility of status | 3 | Real phases, Verified with evidence; one duplicated status line in chat |
| 3 | One standout per view | 3 | No competing primary actions seen |
| 4 | Density discipline | 4 | Exemplary — calm cards, nothing cockpit-like anywhere |
| 5 | Fewer choices | 3 | Settings grouping is right; theme-equality issue from QA Stage 1 not re-verified here |
| 6 | Consistency & vocabulary | 3 | Status vocabulary consistent; orb once per view in inspected views |
| 7 | Posture integrity | 4 | ZERO horizontal overflow in all 90 combinations; fold cover gets its designed Ambient layout, not a stretched phone page |
| 8 | Error & empty states | 2 | Health card leaks a raw file path (rule violation); header phrasing elsewhere is good |
| 9 | Accessibility | 2 | 75 axe semantic violations total; many sub-44pt interactive elements on touch postures |
| 10 | Trust & calm | 3 | No engagement mechanics, honest statuses; duplication wart dents polish |

## Findings (severity order)

F0 (HIGH — added after the owner's challenge, via the first
interaction probe) — COMPOSER DEFORMS WITH LONG INPUT. Typing a long
prompt grows the composer 44px → 256px (5 lines) → capped 328px
(20 lines, ~42% of an 820px viewport), and because the pill radius
scales with height, the grown composer renders as a giant ELLIPSE:
text clips against the curved sides, the first lines slide under
the curve, and the box overlaps the conversation behind it.
Measured + screenshotted (composer-20lines.png in the evidence
folder). The cap and internal scroll exist (good bones); the shape
and cap height are wrong. Fix: fixed radius token for the grown
state (radius/input, not pill), cap height at ~25–30% of viewport,
text padding independent of radius, and the message list must not
be overlapped unreadably. This defect class (interaction states) is
why the skill gained an Interaction Pass (v2) — static screenshots
could never have caught it.

F1 (medium) — HEALTH CARD SHOWS A RAW FILE PATH. Home + Tasks right
column, all postures: "workspace/screenpipe-snapshot/index.sqlite-
wal is larger than 8 MB, so the standby…" — DESIGN-SYSTEM §6: status
and errors in human terms, technical detail ONE TAP AWAY. Fix: card
shows the human summary ("A backup snapshot is larger than usual —
Nova is keeping an eye on it" class), path inside the Health detail
view. (Same family as QA Stage 1's Health raw-API-instruction find;
that one was the empty state, this is the problem state.)

F2 (medium) — RAIL LABEL CLIPPED. Desktop/laptop postures: the rail
item "Automations" overflows the rail width and is cut at the edge.
Fix: widen layout/rail-width token, or labels shrink/wrap — decide
once, apply to all rail items (any future long label hits this).

F3 (medium) — ORB RENDERS AS A FLAT SALMON DISC. Home (all
postures), rail, chat: the orb reads as a flat pink/salmon circle
with a soft highlight, not the "luminous sphere of abstract light"
of DESIGN-SYSTEM §1 and concepts E/H. Caveat: Health had problems
during capture, so this may be the attention state — but even an
attention orb should read as light, not clip-art. Fix: check the
state→color mapping first; then orb/core + orb/glow rendering
(gradient depth, glow falloff) against the concept references.

F4 (low) — DUPLICATED STATUS LINE IN CHAT. Desktop chat shows
"waiting for your OK: this came after reading something from
outside" twice in a row. Fix: dedupe consecutive identical status
lines at render (and check why the event fired twice).

F5 (low) — AXE SEMANTICS, 75 NODES TOTAL. landmark-unique ×35,
empty-table-header ×20, empty-heading ×10, nested-interactive ×10;
worst view /chat (6 per posture). No contrast violations — the
palette is fine; this is markup semantics. Fix as one batch; add the
axe set to CI advisory so it stops regrowing.

F6 (low, needs triage) — SUB-44pt INTERACTIVES ON TOUCH POSTURES.
/chat 61, /capture 63, /activity 37 elements under 44×44. Many are
likely text links inside content (acceptable), but control-sized
targets must be verified per view. Fix: triage list per view; grow
actual controls (chips, icon buttons) to 44pt.

F7 (low) — RIGHT COLUMN DUPLICATES THE PAGE. On /tasks, the right
column still shows "Nova is handling / All tasks" — the page IS all
tasks. Fix: suppress or swap the card on the view it duplicates
(same rule for Devices on a devices view, Health on /health).

F8 (HIGH — real-device find, owner's screenshot, iPhone Duo INNER
display, Settings) — DESKTOP LAYOUT SQUEEZED INTO THE FOLD-INNER
POSTURE. The full three-column Calm Control (rail + center + right
column) renders at fold-inner width: the right column crushes to a
strip where "last seen 3 h ago" wraps one character per line, the
Online/Offline pills OVERLAP the device text they sit beside, and
"Dell XPS 8950" stacks a word per line. DESIGN-SYSTEM §5 says the
fold-inner posture is TWO panes and the right column is off by
default on smaller widths — the build breaks its own rule at this
width. Why the automated pass missed it: page-level overflow was
zero (nothing scrolled sideways; the failure is internal squeeze +
sibling overlap), and the matrix runs Chromium, not WebKit/Safari.
Converted to permanent checks (per the v2 rule): per-region
minimum-content-width assertions, sibling-overlap detection in
cards, WebKit engine added to the matrix, and the app's own test
suite gating the fold postures. Also visible in the shot: a tall
empty safe-area band at top in standalone PWA (minor), and — good
news — the orb rendering teal and luminous in its idle state,
close to the §1 spec (contrast with F3's salmon capture).

F9 (HIGH — real-device, owner's second screenshot, Duo inner
LANDSCAPE, Chat) — same misclassification, second symptom set:
three columns at a width that fits two; the Devices card again
wraps "last seen 3 h ago" a word per line, AND the right column
now OVERFLOWS THE BOTTOM — the card runs off the viewport edge
and is clipped mid-content with no scroll affordance. Root cause
refined: the desktop band's entry width is a round number, not
the sum of the regions' minimum widths (rail + content minimum +
right-column minimum + gaps), so widths in the ~900–1200 range
enter a band whose contents cannot fit. Review-process note: the
duo-inner CHAT view was not in this run's visually-inspected
subset (home/settings were), which is precisely why the fold
prompt requires screenshot baselines in CI rather than eyeballs.

Positives worth naming: chat implements Amendment C faithfully
(un-bubbled Nova turns, tinted tail-less user bubbles, grouped
timestamps); Settings is grouped + searchable as specified; Tasks
uses plain words ("Nothing is done until Nova has checked the
evidence; tap Verified to see it"); the Duo cover display gets the
designed Ambient Home rather than a fallback.

## Top 5 fixes for a builder prompt

1. F1 Health card human summary (rule violation, every home view).
2. F3 Orb luminosity/state-color investigation + fix.
3. F2 Rail label overflow.
4. F5 Axe semantics batch + CI advisory.
5. F4 Chat status dedupe. (F6/F7 follow as a second pass.)
