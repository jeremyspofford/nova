# M9 gate (Feel & Polish, Amendment 2026-10-30-C Part 2): evidence

**The run.**
- **When and where:** 2026-10-30, branch `m9/feel-polish`, on `main` at `bd9326d7` (the ingest gate; `main` hadn't moved since), on this machine, after the review of PR #234 was fixed.
- **Browser tests:** the Playwright v1.56.1 image (`scripts/ui-test.sh`), Chromium and WebKit, against the real server on blank homes.
- **Throttling:** the phone runs of the Web Vitals test slow the CPU 4× through CDP (`Emulation.setCPUThrottlingRate`), as Chrome DevTools' mid-range mobile setting does. The desktop runs are unthrottled. No network throttling: Nova is reached on the local network.

## Counts

| Suite | Command | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- | --- |
| Unit, core, acceptance (with lint:tokens, check:themes, typecheck) | `npm run check` | 971 | 962 | 0 | 9 |
| Browser (the whole UI gate) | `scripts/ui-test.sh` | 55 | 55 | 0 | 0 |

**The 9 skipped tests** are opt-in runs that need real outside things. None is new to M9:
- real Claude Code (`NOVA_REAL_CLAUDE`);
- the local Ollama (`NOVA_REAL_OLLAMA`, four of them);
- a Relay checkout (`NOVA_RELAY_DIR`, three of them);
- a desktop `secret-tool`.

**The fresh-user test still passes:**
- `tests/acceptance/fresh-user.test.ts`, inside `npm run check`;
- `tests/ui/setup-pwa.test.ts`: blank-profile setup from the PWA alone, at phone, tablet and desktop widths.

**What M9 added:**
- 16 browser tests, in `tests/ui/m9-*.test.ts`;
- 25 unit tests, in `tests/m9-motion.test.js`, `tests/m9-wait.test.js`, `tests/m9-stream-order.test.js` and `tests/core/design-before-m9.test.ts`.

**Changed assertions.** These existing assertions now state the new decisions; none is looser:
- the right column now starts at 1024 px, not 1280 (`tests/ui-logic.test.js`);
- a type token now goes out in rem (`tests/core/design.test.ts`, `--type-h1: 1.75rem`);
- a third-party design's validation answer now carries `warnings`; it is still checked to have no problems, and its two motion warnings are counted (`tests/core/design-api.test.ts`).

**The fixture had been changed, and now isn't.** The first version of this PR changed `tests/core/fixtures/design-system.json` (motion 120/320 ms → 150/300 ms) to fit the new motion rule. That hid a real defect: every design made before M9 failed validation. The fixture is back to its pre-M9 values, and a test now checks that a pre-M9 design (the fixture, and an old Orb Teal copy) validates, applies and is clamped (`tests/core/design-before-m9.test.ts`).

## Core Web Vitals at p75 (`tests/ui/m9-vitals.test.ts`)

Each view and width ran 12 times, each in a fresh browser context. The figure is the 75th percentile by nearest rank (the 9th of 12).
- **LCP:** the last `largest-contentful-paint` before the first input.
- **CLS:** the largest session window of `layout-shift`, without `hadRecentInput` shifts.
- **INP:** the longest interaction by `interactionId`, from `event` timing with `durationThreshold: 16`.
- **Interactions:** real, trusted input:
  - in chat, a message typed and sent, measured until Nova's reply has streamed in and finished (a stand-in model that thinks for 0.4 s, then writes in pieces);
  - typing in search;
  - opening a task or its evidence, and Escape;
  - opening a memory to edit, and Escape;
  - choosing a Settings result;
  - then a tap or click on the navigation, so the next view's drawing is counted.

| View | Width | Runs | LCP p75 (≤ 2500 ms) | INP p75 (≤ 200 ms) | CLS p75 (≤ 0.1) | Interactions per run |
| --- | --- | --- | --- | --- | --- | --- |
| Home | phone 390×844, CPU 4× | 12 | 420 ms | 64 ms | 0.000 | 3 |
| Chat | phone 390×844, CPU 4× | 12 | 332 ms | 88 ms | 0.000 | 29–30 |
| Tasks | phone 390×844, CPU 4× | 12 | 428 ms | 64 ms | 0.000 | 3 |
| Settings | phone 390×844, CPU 4× | 12 | 512 ms | 80 ms | 0.000 | 8 |
| Memory | phone 390×844, CPU 4× | 12 | 432 ms | 64 ms | 0.000 | 3 |
| Home | desktop 1280×820 | 12 | 140 ms | 40 ms | 0.000 | 3 |
| Chat | desktop 1280×820 | 12 | 156 ms | 40 ms | 0.000 | 29 |
| Tasks | desktop 1280×820 | 12 | 148 ms | 40 ms | 0.000 | 3 |
| Settings | desktop 1280×820 | 12 | 204 ms | 48 ms | 0.000 | 6–8 |
| Memory | desktop 1280×820 | 12 | 164 ms | 40 ms | 0.000 | 3 |

**What changed from the first version of this PR.** Its phone runs were unthrottled and its chat runs didn't send a message. With the phone's CPU slowed 4×, phone LCP rose from 156–240 ms to 332–512 ms, and INP from 40–56 ms to 64–88 ms. Desktop numbers are within run-to-run variation of the first ones. All are within the gate.

**What the measurements found, before the fixes:**
- On every desktop view, CLS was 0.059 (0.070 in chat). The page painted in the phone layout and then moved to the desktop one.
- On desktop Tasks, INP p75 was 240 ms in a 3-run trial. Closing the task sheet repainted a whole-screen backdrop blur.
- After the review, with messages sent in chat: desktop chat CLS p75 was 0.091 (passing, but near the line). In 2 of 12 runs, once the conversation was long, turns on screen at its end were laid out from `content-visibility`'s 480 px estimate and then moved.

All three are fixed (see the LEDGER).

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

**When the shape can't be the same** (`tests/ui/m9-skeleton-changed.test.ts`, desktop):
- **Another conversation, never opened on this device:** no skeleton is borrowed from the conversation that was. A waiting line shows from 1 s, and the conversation arrives with no layout shift. (The first version of this PR kept one chat shape for every conversation.)
- **Tasks, after three new tasks arrived while the page was away:** the kept shape is the last visit's.
  - The heading lands exactly where its skeleton stood.
  - The list starts where its skeleton did and grows below it (304 → 475 px).
  - The layout shift is 0.
  - The new shape is kept for next time.

  A skeleton can't know data it hasn't been given. What the gate can hold is that the swap moves nothing, and here it doesn't.

## Progress rules (`tests/ui/m9-progress.test.ts`, `tests/m9-wait.test.js`)

**A view that waits** (Tasks, with its data held):
- At 0.3 s, no indicator is seen.
- From 1 s it reads "Loading Tasks…".
- After 10 s it reads "Loading Tasks… · 0 of 12 parts · 11 s so far · it usually takes under a second": real units, no percentage, and a general estimate.
  - The estimate is there even with no history on this device: each kind of wait has a built-in one. This device's own history replaces it once there is some.
  - A unit test checks that every wait the PWA names has one.
- When the data is quick, no indicator is ever seen.

**Chat, against a stand-in model that thinks for 11.5 s before a word:**
- Your words show at once.
- Under 1 s there is no indicator.
- From 1 s it reads "Thinking…", the phase named on screen and never "typing".
- After 10 s it reads "Thinking… · 1x s so far · it usually takes about half a minute".
- The reply grows only through the pieces the model sent, and each state is a real prefix.

**A finished conversation** is drawn whole. There is no caret, and nothing changes 0.8 s later.

**Streaming in order** (`tests/m9-stream-order.test.js`, through the runner):
- A test model streams a ```xml fence, or only blank lines, then a tool call, then its answer in pieces.
- The page's rule, applied to the events, shows every piece once.
- Nothing of the first step is left once it turns to its tool.
- Thinking shows between the steps.

**On the page's own clock** (`tests/ui/m9-skew.test.ts`): with the device's clock 5 min ahead of the hub's, and then 5 min behind, Thinking is still unseen under 1 s and reads "Thinking…" from 1 s.

**Never blank** (`tests/ui/m9-never-blank.test.ts`):
- A hub that never answers: the page shows within ~1 s, and says "Nova's server isn't answering".
- An error thrown while the page starts: it still shows.
- A conversation that doesn't exist ends on the empty conversation; it isn't "Loading…" for good.

**Optimistic UI is honest:**
- A send held by the server shows "Sending…" only from 1 s, and its real length (about 1.5 s) is kept for next time.
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
| phone | 45, all 150–300 ms, transform/opacity only | fade-in, rise, opacity, translate | 2 (orb, pulse) | 41 changes, all ≤ 1 ms, no loop running |
| desktop | 60, all 150–300 ms, transform/opacity only | fade-in, rise, opacity, translate | 2 | 50 changes, all ≤ 1 ms, no loop running |

**Validation and lint:**
- **Package validation** names transitions outside 150–300 ms and easing curves that overshoot as **warnings**. The generated CSS clamps them, so a design made before M9 still applies. All six built-ins are in range (unit test).
- The lint rejects animating anything but transform and opacity.
- It rejects a finite duration that isn't one of the three transition tokens.
- It rejects a one-off keyframe that goes there and back.

## Contrast (`tests/ui/m9-contrast.test.ts`)

All six built-ins were measured in every look they have, at 1280×820 and at 390×844, on Home, chat, Tasks, Memory, Settings and three of its categories:
- The keyboard went through every stop of each view, until focus came round.
- At phone width there is no hover. Instead, the tabs, the conversations drawer, More, a task's sheet and a toast were each measured open.

The standards:
- Text: 4.5:1, or 3:1 when large.
- Focus indicators against what is next to them: 3:1.
- Icon-only buttons: 3:1.

Every look measured the same counts at each width:

| Width | Text at rest | Hovered | Focused | Selected | Disabled | Error | Placeholder | Icons | Overlays |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop | 358 | 70 | 234 | 30 | 2 | 1 | 6 | 7 | — |
| phone | 275 | — | 179 | 26 | 2 | 1 | 6 | 3 | 5 |

All 16 measurements pass (8 looks × 2 widths): Aurora light and dark, Companion Light, Nova, Obsidian, Orb Teal, Paper light and dark.

**The first run found 288 places below AA:**
- faint text;
- status words in their status colour;
- secondary text on hover tints and over the raised end of the page;
- default placeholders;
- Orb Teal's error colour on cards.

They are fixed in CSS, plus a few token values (see the LEDGER).

The phone pass, added after review, found one more: the toast's Undo was in the accent on a hover tint, at 4.01–4.32:1 in Paper, Orb Teal and Companion Light. It is in the primary text colour now.

The disabled and error states are thinly represented in the views (2 and 1 elements per look). The token checks (`LIVE_CHECKS`, extended) cover their colours in every package.

## Hit areas (`tests/ui/m9-targets.test.ts`)

At 390×844 with touch, every control must take a 5×5 grid of points over a 48×48 box (a coarse pointer, so 48 dp; 44 pt elsewhere). The test covered:
- 20 states;
- every view, each Settings category and Settings search;
- the composer with text, a tapped message;
- the conversations drawer, More, and a task sheet;
- a memory being edited;
- a toast with its action.

At 1280×820 with a pointer, every control takes 44×44, the rail and the right column included. That covered 9 states: every view, the composer with text, the drawer, More and a task sheet.

All pass. The toast's action, newly checked, was 29 px tall; it is 48×48 now.

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
