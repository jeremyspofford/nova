# M9 gate (Feel & Polish, Amendment 2026-10-30-C Part 2): evidence

**The run.**
- **When and where:** 2026-10-30, branch `m9/feel-polish`, after merging `main` at `bd9326d7` (the ingest gate), on this machine.
- **Browser tests:** the Playwright v1.56.1 image (`scripts/ui-test.sh`), Chromium and WebKit, against the real server on blank homes.
- **No throttling.** The Docker browser is software-rendered with no GPU, so its paints are slower than a phone's or a laptop's, not faster.

## Counts

| Suite | Command | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- | --- |
| Unit, core, acceptance (with lint:tokens, check:themes, typecheck) | `npm run check` | 962 | 953 | 0 | 9 |
| Browser (the whole UI gate) | `scripts/ui-test.sh` | 51 | 51 | 0 | 0 |

**The 9 skipped tests** are opt-in runs that need real outside things. None is new to M9:
- real Claude Code (`NOVA_REAL_CLAUDE`);
- the local Ollama (`NOVA_REAL_OLLAMA`, four of them);
- a Relay checkout (`NOVA_RELAY_DIR`, three of them);
- a desktop `secret-tool`.

**The fresh-user test still passes:**
- `tests/acceptance/fresh-user.test.ts`, inside `npm run check`;
- `tests/ui/setup-pwa.test.ts`: blank-profile setup from the PWA alone, at phone, tablet and desktop widths.

**What M9 added:**
- 12 browser tests, in `tests/ui/m9-*.test.ts`;
- 16 unit tests, in `tests/m9-motion.test.js` and `tests/m9-wait.test.js`.

**Changed assertions.** Two existing assertions now state the new decisions; neither is looser:
- the right column now starts at 1024 px, not 1280 (`tests/ui-logic.test.js`);
- a type token now goes out in rem (`tests/core/design.test.ts`, `--type-h1: 1.75rem`).

## Core Web Vitals at p75 (`tests/ui/m9-vitals.test.ts`)

Each view and width ran 12 times, each in a fresh browser context. The figure is the 75th percentile by nearest rank (the 9th of 12).
- **LCP:** the last `largest-contentful-paint` before the first input.
- **CLS:** the largest session window of `layout-shift`, without `hadRecentInput` shifts.
- **INP:** the longest interaction by `interactionId`, from `event` timing with `durationThreshold: 16`.
- **Interactions:** real, trusted input:
  - typing in the composer and in search;
  - opening a task or its evidence, and Escape;
  - opening a memory to edit, and Escape;
  - choosing a Settings result;
  - then a tap or click on the navigation, so the next view's drawing is counted.

| View | Width | Runs | LCP p75 (≤ 2500 ms) | INP p75 (≤ 200 ms) | CLS p75 (≤ 0.1) | Interactions per run |
| --- | --- | --- | --- | --- | --- | --- |
| Home | phone 390×844 | 12 | 224 ms | 56 ms | 0.000 | 3 |
| Chat | phone 390×844 | 12 | 156 ms | 48 ms | 0.000 | 28 |
| Tasks | phone 390×844 | 12 | 216 ms | 48 ms | 0.000 | 3 |
| Settings | phone 390×844 | 12 | 240 ms | 40 ms | 0.000 | 4–8 |
| Memory | phone 390×844 | 12 | 208 ms | 48 ms | 0.000 | 3 |
| Home | desktop 1280×820 | 12 | 192 ms | 48 ms | 0.000 | 3 |
| Chat | desktop 1280×820 | 12 | 204 ms | 40 ms | 0.000 | 24–28 |
| Tasks | desktop 1280×820 | 12 | 252 ms | 40 ms | 0.000 | 3 |
| Settings | desktop 1280×820 | 12 | 276 ms | 56 ms | 0.000 | 6–8 |
| Memory | desktop 1280×820 | 12 | 208 ms | 72 ms | 0.000 | 3 |

**What the first measurements found, before the fixes:**
- On every desktop view, CLS was 0.059 (0.070 in chat). The page painted in the phone layout and then moved to the desktop one.
- On desktop Tasks, INP p75 was 240 ms in a 3-run trial. Closing the task sheet repainted a whole-screen backdrop blur.

Both are fixed (see the LEDGER).

## Skeletons (`tests/ui/m9-skeleton.test.ts`)

The test opened each view once, then reloaded it with its data held. The service worker was off, so it couldn't answer for the held requests.

| Width, view | Blocks | Largest difference from the final rect | Layout shift across the swap |
| --- | --- | --- | --- |
| phone, Home | 7 | 0.00 px | 0 |
| phone, Tasks | 2 | 0.00 px | 0 |
| phone, Memory | 5 | 0.00 px | 0 |
| phone, chat | 15 | 0.00 px | 0 |
| desktop, Home | 4 | 0.00 px | 0 |
| desktop, Tasks | 2 | 0.00 px | 0 |
| desktop, Memory | 5 | 0.00 px | 0 |
| desktop, chat | 15 | 0.00 px | 0 |

**Also checked:**
- At 0.4 s, the skeleton's opacity is 0: nothing is seen under 1 s.
- At 1.5 s, it is 1.
- It has the content's lines, not just frames.

In a conversation, only the blocks on screen are compared. Turns far above the screen are laid out as estimates (`content-visibility`), in the skeleton and the view alike.

## Progress rules (`tests/ui/m9-progress.test.ts`, `tests/m9-wait.test.js`)

**A view that waits** (Tasks, with its data held):
- At 0.3 s, no indicator is seen.
- From 1 s it reads "Loading Tasks…".
- After 10 s it reads "Loading Tasks… · 0 of 12 parts · 11 s so far": real units, and no percentage.
- When the data is quick, no indicator is ever seen.

**Chat, against a stand-in model that thinks for 11.5 s before a word:**
- Your words show at once.
- Under 1 s there is no indicator.
- From 1 s it reads "Thinking…", the phase named on screen and never "typing".
- After 10 s it reads "Thinking… · 1x s so far".
- The reply grows only through the pieces the model sent, and each state is a real prefix.

**A finished conversation** is drawn whole. There is no caret, and nothing changes 0.8 s later.

**Optimistic UI is honest:**
- A send held by the server shows "Sending…" only from 1 s.
- A failed send puts the words back in the box, with the server's reason.
- A memory edit shows the new words at once, "Saving…" from 1 s, and "Saved" only after the server answers.
- A failed edit shows what is really saved and the reason, and "Edit again" brings back what was typed.

**The code, tested statically:**
- Every timer in `ui/js` carries a `wait:` note saying what it is: a poll, retry, debounce, expiry, long press, clock or after-the-event.
- No "Loading…", "Checking…" or "Waiting for…" is drawn outside `wait.js`.
- Live text is written only from the server's deltas.
- No timer reveals text a piece at a time.

## Motion (`tests/ui/m9-motion.test.ts`, `tests/m9-motion.test.js`, `lint:tokens`)

Real actions on all five views, recorded through `animationstart` and `transitionrun`:

| Width | One-off animations and transitions | Kinds | Loops | Reduced motion |
| --- | --- | --- | --- | --- |
| phone | 27, all 150–300 ms, transform/opacity only | fade-in, rise, opacity, translate | 2 (orb, pulse) | 23 changes, all ≤ 1 ms, no loop running |
| desktop | 60, all 150–300 ms, transform/opacity only | fade-in, rise, opacity, translate | 4 | 50 changes, all ≤ 1 ms, no loop running |

**Validation and lint:**
- Package validation rejects transitions outside 150–300 ms and easing curves that overshoot.
- The lint rejects animating anything but transform and opacity.
- It rejects a finite duration that isn't one of the three transition tokens.
- It rejects a one-off keyframe that goes there and back.

## Contrast (`tests/ui/m9-contrast.test.ts`)

All six built-ins were measured in every look they have, at 1280×820, on Home, chat, Tasks, Memory, Settings and three of its categories:
- Text: 4.5:1, or 3:1 when large.
- Focus indicators against what is next to them: 3:1.
- Icon-only buttons: 3:1.

| Look | Text at rest | Hovered | Focused | Selected | Disabled | Error | Placeholder | Icons | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Aurora (light) | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Aurora (dark) | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Companion Light | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Nova | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Obsidian | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Orb Teal | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Paper (light) | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |
| Paper (dark) | 345 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | all pass |

**The first run found 288 places below AA:**
- faint text;
- status words in their status colour;
- secondary text on hover tints and over the raised end of the page;
- default placeholders;
- Orb Teal's error colour on cards.

They are fixed in CSS, plus a few token values (see the LEDGER). The disabled and error states are thinly represented in the views (2 and 1 elements per look). The token checks (`LIVE_CHECKS`, extended) cover their colours in every package.

## Hit areas (`tests/ui/m9-targets.test.ts`)

At 390×844 with touch, every control must take a 5×5 grid of points over a 48×48 box (a coarse pointer, so 48 dp; 44 pt elsewhere). The test covered:
- 20 states;
- every view, each Settings category and Settings search;
- the composer with text, a tapped message;
- the conversations drawer, More, and a task sheet;
- a memory being edited.

All pass.

The first run found 246 controls under 44 px, among them:
- icon buttons at 40;
- small buttons at 32;
- chat actions at 16×24;
- disclosures at 21;
- links in card headers at 18.

**Exempt, and named in the test:**
- links inside running text (WCAG 2.5.8's inline exception);
- a message's time, which a finger reveals by pressing the whole message.

## Foldable and responsive (`tests/ui/m9-fold.test.ts`), in the amendment's order

**1. State survives.** The test went folded (390×844) → unfolded (884×1104) → half-open (a real 24 px hinge) → a 1280×820 window → folded again:
- The conversation's message at the top stayed at its offset (−4 px) at every step.
- The composer draft was intact.
- An unsaved "Your name" edit kept its text and its focus.
- Its category stayed open.

**2. No stretched single column.** At 840, 1024, 1280 and 1920 px, every main view has a second pane:

| Width | Second pane | Nova's prose |
| --- | --- | --- |
| 840 | the right column, 236 px (Settings: its sidebar, 224 px) | 47ch |
| 1024 | the right column, 352 px | 54ch |
| 1280 | the right column, 352 px | 70ch |
| 1920 | the right column, 352 px | 70ch |

Only chat has paragraphs long enough to wrap in the seeded profile. All paragraphs and list items are capped at 70ch.

**3. Nothing under the hinge.** Chromium's display feature gives the page real viewport segments. The test checked the book posture (1200×800, a vertical hinge at 588–612) and the laptop posture (800×1200, a horizontal one):
- no text, control, image or orb overlaps the hinge on any of the five views;
- nor with the conversations drawer, More, a task's sheet or a toast open.

**4. 200% text.** With the browser's default font size doubled (16 → 32 px, through CDP `Page.setFontSizes`), at 390×844 and 1280×820, on all five views:
- body text is 32 px;
- nothing scrolls sideways;
- no text is cut off by its box;
- no control overlaps another;
- every destination is reachable.

The existing posture sweep (7 widths × 4 postures) and every-destination tests still pass.

## Screenshots: `docs/screenshots/m9/`

| What | Files |
| --- | --- |
| Skeletons, and the view that replaced them | `skeleton-{phone,desktop}-{home,chat}.png`, `…-loaded.png` |
| Waiting after 10 s, real units | `waiting-tasks-after-10s.png` |
| Thinking, at 1 s and after 10 s | `chat-thinking.png`, `chat-thinking-after-10s.png` |
| The hinge, book and laptop postures | `hinge-{book,laptop}-{home,chat,conversations-open,a-task-open}.png` |
| Second panes | `panes-{1024,1920}-{chat,settings}.png` |
| 200% text | `text-200-{phone,desktop}-{home,chat,tasks,settings,memory}.png` |
