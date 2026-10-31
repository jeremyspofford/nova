# Fold postures: derived band widths, card minimums, no crushed or clipped columns (F8/F9)

**Source:** the owner's UX review of 2026-10-31 (`nova-ux-review-2026-10-31.md`), findings F8 and F9,
which came from real-device screenshots of an installed Nova on a foldable phone's inner screen.
The fix list is owner-approved and binding. Evidence of the review: `~/workspace/nova-qa/evidence/ux-review-2026-10-31/`.

**How it was measured:** `tests/ui/fold-postures.test.ts`, in the Playwright container
(`scripts/ui-test.sh`), against the seeded profile of UX review 1 (`reviewProfile`: a conversation with
tables, held memory, an open problem) and a mesh like the owner's: the hub, a desktop with a long
name, and a phone last seen 3 h ago. The test prints every number below (`FOLD …` lines). "Before" is
`origin/main` at `9073f381` with the same test; "after" is this branch.

## The causes

- **F8 (Settings on the inner screen, upright).** Under 1024 px every flat screen got the tablet
  layout, and the tablet layout always drew three columns: the rail, the centre (held at about 50ch),
  and a right column sized `minmax(0, 352px)`, so the right column took whatever was left, down to
  nothing. At 820 px it was 208 px wide, its cards 159 px, a device row's words 1 px across: "Phone ·
  last seen 3 h ago" wrapped over 7 lines at 3.6 characters a line, and the Online/Offline pills were
  drawn over the device names that spilled out of their 1 px box. Settings under 840 px (its grouped
  list) kept the right column too; at 840 px and up its sidebar layout hid it, which is why the
  review's 900 px Settings looked fine and the owner's narrower screen didn't.
- **F9 (Chat on its side).** The same classification: the three-column band started at a round
  number (1024 px, and three columns at any tablet width), not where its columns fit.
- **The right column running off the bottom** was not reproduced in either engine: the right column
  was already its own scroller (`overflow-y: auto`) in every band, and scrolled to its end. What the
  app did get wrong on a real device: with `viewport-fit=cover` it drew to the screen's edges but
  kept no safe-area inset except the phone tabs' bottom one, so on its side the rail sat under the
  camera cutout and the columns' last lines under the home indicator. That is fixed below; the gate
  now asserts the right column scrolls to its last card at a short landscape height.

## The fix

**1. The bands are derived from the regions' minimums** (`ui/styles/layout.css`):

| region | minimum |
|---|---|
| rail | `layout/rail-width` |
| main | `45ch + 2 × space/5 + 2 × scrollbar`: M9's readable measure, the view's padding, a scrollbar gutter each side (the scroller keeps both) |
| card | `20ch + 2 × space/5`: "last seen 3 h ago" on one line, a two-word heading unbroken |
| right column | `card + 2 × space/5 + scrollbar` |

- The **three-column band** (desktop) starts at **rail + main + right column**.
- The **two-column band** (the rail and one column) starts at `max(600px, rail + main)`: the
  compact width class stays the floor under which a phone gets bottom tabs.

These are custom properties `ui/` declares (`--region-*`, `--band-two`, `--band-three`), computed from
the design system's own tokens, so no schema token was added and no package changed. CSS can't use a
custom property in a media query, so `ui/js/shell.js` measures the two band widths off never-seen
probe elements (and the browser's scrollbar width, 0 where scrollbars overlay), compares them with the
viewport, and sets `data-layout`. A design system swapped live, a web font arriving or a bigger text
size resizes the probes, and a `ResizeObserver` reads the layout again: no reload. `ui/js/layout.js`
gained the pure `viewportOf(width, bands)`.

Below the three-column band a flat tablet is **the rail and one column**: no right column to crush,
and its three cards are on Home (as on a desktop with the right column closed). Half-open postures
keep their second pane: stacked when the panes don't fit side by side, on each screen of a real hinge.

**Derived widths, per design system** (px; in the Playwright container, whose browsers hide
scrollbars, so the scrollbar term is 0; a desktop with 15 px classic scrollbars adds 45 px to the
three-column band and 30 px to the main minimum):

| design system | main min | right column min | card min | **three-column band** (Chromium / WebKit) | two-column band |
|---|---|---|---|---|---|
| Orb Teal | 479.7 | 287.9 | 239.9 | **851.6 / 851.6** | 600 |
| Companion Light | 479.7 | 287.9 | 239.9 | **851.6 / 851.6** | 600 |
| Paper | 466.2 | 281.9 | 233.9 | **832.1 / 832.1** | 600 |
| Aurora | 423.4 | 262.8 | 214.8 | **770.2 / 770.2** | 600 |
| Nova | 410.9 / 439.2 | 257.3 / 269.9 | 209.3 / 221.9 | **752.2 / 793.1** | 600 |
| Obsidian | 398.4 / 425.8 | 251.7 / 263.9 | 203.7 / 215.9 | **734.1 / 773.6** | 600 |

(The rail is 84 px in all six. Nova and Obsidian name fonts the container lacks, and the two engines
fall back differently; that is exactly why the widths are measured, not written down.)

**2. Cards have minimum widths and stack below them.** Home's two-across cards
(`repeat(auto-fit, minmax(max(card min, half), 1fr))`) stack below the card minimum. A device row
keeps 12 characters for its name and line beside the icon and moves its pill under them when there
isn't room for all three (`flex-wrap`), and a long name breaks rather than spilling into the pill.

**3. Nothing scrolls sideways that shouldn't.** The rail scrolled 5–10 px sideways on every rail
layout (the orb's glow), and a phone's Home view 4–15 px (the hero orb's glow at its fullest breath,
in Chromium). The rail, and a phone's view, scroll up and down only now (`overflow-x: hidden`);
tables and code keep their own sideways scroll.

**4. Safe area.** The shell keeps each inset clear once: `padding: env(safe-area-inset-*)` on
`.shell` (the bottom one left to the phone's tabs, which already had it).

## The gate (`tests/ui/fold-postures.test.ts`, run by the UI gate job in CI)

1. **The matrix:** the review's ten postures (desktop-1920, laptop-1366, ipad-portrait, ipad-landscape,
   iphone, iphone-large, android, duo-cover, duo-inner, duo-halfopen; the same sizes) × the review's
   nine views, in **Chromium and WebKit**, plus a short landscape (1100×560) where the right column
   must hold more than it shows: 184 combinations. In each, from inside the page (`tests/ui/fold-support.ts`):
   - nothing outside the viewport that no scroller can bring into view (the orb's glow excepted);
   - no scroller scrolling sideways unless it is a table, code or a driven page;
   - nothing cut by a box that hides its overflow;
   - no text block under 8 characters a line: each block's line boxes, from its text's client
     rects, against its characters;
   - no siblings drawn over each other: every in-flow child's box, its line boxes if inline, and any
     of its text spilling out of it, against every other child and the parent's own loose text;
   - no card under the card minimum;
   - the right column scrolls or isn't there (and at 1100×560 it overflows, scrolls, and scrolled to
     its end shows its last card whole);
   - three columns only from the derived width, each column at least its minimum.
2. **The derivation, in every design system:** all six, in both engines, at every width from 560 to
   1440 px in 40 px steps, on Home, Chat and Settings: the same assertions, the layout exactly what
   the derived bands say, and the three-column band equal to the sum of its regions. Then a design
   system swapped live moves the band without a reload (Paper 832.1 → Companion Light 851.6).
3. **Screenshot baselines** (`tests/ui/baselines/fold/`, 20 PNGs, both engines): duo-cover (Home,
   Chat, Settings), duo-inner upright (Home, Chat, Settings), duo-inner on its side, 1100×900 (Home,
   Chat), and F8's own width, 820×1100 (Home, Settings). Times, the greeting and "last seen" are masked;
   animations are stopped. A picture fails when more than 2% of its pixels move by more than 48 in a
   channel. Two runs in the container differed by 0.00%; the pre-fix layout differs by 2.9–9.2%.
   Rewrite them with `NOVA_UPDATE_BASELINES=1 scripts/ui-test.sh tests/ui/fold-postures.test.ts`; in
   CI a missing baseline fails.
4. **The safe area** (below).

`tests/ui/posture-sweep.test.ts` now expects the layout from the page's derived bands, and M9's
"foldable 2" requires a second pane in the three-column band (and Settings' sidebar from 840 px);
under the band it checks the centre keeps its content width instead. That is the owner-approved
rule ("below it, the layout uses the two-column band"), and it changes M9's "every expanded width
gives its extra room to a second pane" for widths between 840 px and the derived band (840–851 px in
Orb Teal and Companion Light in the container; more where scrollbars take room). The rest of the UI
suite is unchanged.

## Before and after

All 184 combinations (Chromium and WebKit together):

| | before | after |
|---|---:|---:|
| text blocks under 8 characters a line | 140 | 0 |
| fewest characters a line, anywhere | 3.5 | 12.5 |
| siblings drawn over each other | 54 | 0 |
| cards under their minimum | 102 | 0 |
| scrollers scrolling sideways | 114 | 0 |
| past the viewport with no way to scroll to it | 0 | 0 |
| cut off | 0 | 0 |
| combinations with any problem | 114 | 0 |

The review's failing postures (identical in both engines except where noted):

| posture | before | after |
|---|---|---|
| 820×1180 (ipad-portrait; F8's Settings) | tablet, three columns 84 / 528 / **208** px; cards **159 px**; "Phone · last seen 3 h ago" **7 lines at 3.6** characters a line, "The hub" 3.5, "Hub · this device" 4.3, "System health" 6.5; the three pills drawn over the three device names; Settings the same | tablet, **two columns** 84 / 736; the cards on Home at full width; nothing under 8 a line, nothing drawn over |
| 900×1100 (duo-inner) | tablet, three columns 84 / 528 / 288; cards 239 px; "Study desktop 8950" 3 lines at 6 a line, "Folding phone" 6.5 | three-column band (900 ≥ 851.6): 84 / 480 / 336; cards 288 px; fewest 12.5 a line; device pills beside their names |
| 1100×900 (duo-halfopen; F9's Chat) | 84 / 664 / 352; fitted; the rail scrolled 5 px sideways | the same columns; no sideways scroll |
| 1100×560 (on its side, short) | the right column scrolled (both engines) | the same, now asserted, last card whole at the end |
| 360 / 380 Home (Chromium) | the view scrolled 14 / 5 px sideways | 0 |

Screenshots (WebKit, the iPhone's engine): `docs/screenshots/fold/before-webkit-820-settings.png` →
`after-webkit-820-settings.png`; `before-webkit-900-home.png` → `after-webkit-900-home.png`;
`before-webkit-900-chat.png` → `after-webkit-900-chat.png`; and `after-webkit-1100-landscape-chat.png`.
The magenta boxes are the masked times.

## The safe area (item 5)

**What Playwright allows:** neither engine can run as an installed app (there is no standalone
display mode to emulate), and WebKit always reports insets of 0. Chromium can report insets
(DevTools' `Emulation.setSafeAreaInsetsOverride`), as an installed app with `viewport-fit=cover` gets
them. So the test checks WebKit for what the app adds on its own, and Chromium with the insets of a
notched phone upright (47 top, 34 bottom) and on its side (47 left and right, 21 bottom).

**Finding: there was no excess safe-area padding.** Before this change the only `env(safe-area-inset-*)`
in Nova was the phone tabs' bottom one. In WebKit the app adds 0 px at the top at duo-inner, duo-cover
and iphone; on Settings the top bar is 52 px and the title starts at 88 px. The tall empty band in the
owner's screenshot is the iOS status bar (with no `apple-mobile-web-app-status-bar-style`, iOS draws an
installed app below its own status bar) above Nova's 52 px top bar, which beside a rail holds only
the capture chip. The opposite was wrong: the app ignored the insets. With them emulated, before:
14 controls inside an inset on its side (rail items under the cutout, top-bar buttons, the composer's
buttons under the home indicator), 4–6 upright on the inner screen, 2 on an iPhone's Chat; after: 0,
and each inset is kept exactly once (47 top; 34 bottom; 47 / 47 at the sides), never doubled.

**Not changed (owner's call):** drawing the app under the status bar (`black-translucent`) would merge
that band into Nova's background, but iOS then writes the status bar in white, unreadable over
Companion Light and Paper.

## Limits

- The derived widths depend on the fonts the browser actually has; the table is the container's.
  On a phone with SF Pro the bands come out a little lower (narrower glyphs, overlay scrollbars).
- WebKit in Playwright is Linux WebKit, not iOS Safari: no standalone mode, no insets, no iOS
  scrollbars. The real-device check of F8/F9 is still the owner's.
- With the right column closed by the person, a conversation's margin notes ("Kept in memory") are
  placed beside it at any desktop width. Near the bottom of the three-column band there isn't room,
  and the view scrolls sideways to reach them, as it already did at 1024 px. It isn't part of F8/F9,
  and the matrix runs with the right column open. Noted.
- The UI gate takes about 3½ minutes longer (the matrix is under 2 of them).

## NOTES for Track 1

**What changed (plain language), for the LEDGER entry:**
- What changed: on a folding phone's inner screen, a tablet held upright, or any window between a
  phone and a laptop, Nova no longer squeezes three columns in. Each column has a smallest width,
  and the side column with your tasks, devices and health only appears when all three fit; until
  then those cards are on Home. No text is squeezed to a few letters a line, the Online/Offline
  labels no longer sit on top of device names, and the side column scrolls instead of running off
  the screen. On an installed app, nothing sits under the camera cutout or the home bar any more.
- What you can now do: use Nova on the fold's inner screen in either direction, in any of the six
  designs, and read every card.
- Still unfinished: checking it on your real phone (the tests use the iPhone's engine, but not as an
  installed app). Whether the app should draw behind the iPhone's status bar, which would remove the
  empty band at the top but makes the time and battery white on the light designs, is your call.

**Decision recorded in the LEDGER:** the bands are derived from the regions' minimums; under the
three-column band a flat tablet is the rail and one column; M9's second-pane rule now applies from the
three-column band.
