# The iOS status bar, per design (owner decision 2C)

**Source:** the owner's decision of 2026-10-31, option C, recorded in DESIGN-SYSTEM §5 (PR #269,
branch `docs/owner-decisions-capture-statusbar`). It follows UX review F8 (PR #267), which found the
empty band at the top of an installed Nova on an iPhone was iOS's own status bar strip, and left
drawing behind it to the owner.

## What was built

- **Each design package declares it:** `ios_status_bar` in the package format
  (`src/core/design.ts`), either one word for a design with one look, or `{ light, dark }` for a
  design with both:
  - `translucent`: the installed app draws behind the status bar
    (`apple-mobile-web-app-status-bar-style` = `black-translucent`), so Nova's background reaches the
    top edge;
  - `default`: iOS keeps its own strip above Nova.
- **The six built-ins, by what they are** (each look's `bg/base`, the same test the CSS uses for
  `color-scheme`):

  | design | looks | `ios_status_bar` |
  |---|---|---|
  | Orb Teal | dark only | `translucent` |
  | Nova | dark only | `translucent` |
  | Obsidian | dark only ("always dark") | `translucent` |
  | Companion Light | light only | `default` |
  | Aurora | light, with a dark mode | `{ light: default, dark: translucent }` |
  | Paper | light, with a dark mode | `{ light: default, dark: translucent }` |

  Each package's patch version went up by one.
- **The check:** a word outside the two, or `translucent` over a light look, is a problem (iOS
  draws the time and battery in white, unreadable on a light page). `default` over a dark look is a
  warning only: nothing is unreadable, but the owner's rule says dark designs draw behind it.
- **A package that leaves it out** (the choice the brief asked for):
  - `npm run check:themes` **fails** it, so every package authored against the gate (the six
    built-ins, anything Nova's foundry makes) says what it wants;
  - Nova itself still **applies** it, with an explicit default of `default` and a warning. That is
    what iOS does with no tag, it is readable over any look, and a design made before this change
    (or by hand) keeps working instead of becoming unusable after an update.
- **The tag in the page** (`ui/index.html`):
  - the server writes the words of the design this device shows into the tag before sending the
    page, so the value is there when iOS reads it, at launch (the device is known from a cookie;
    see the limit below);
  - a one-line script right after it picks light or dark exactly as the design's CSS does: the
    chosen mode, or the system's preference under Auto. That matters only for Aurora and Paper
    under Auto;
  - `theme.js` keeps it current: on a live design swap (from any device), a change of light and
    dark, and the system turning dark or light.
- **The top bar sits under the status bar:** no CSS change was needed. Since PR #267 the shell
  keeps `env(safe-area-inset-top)` clear exactly once, for every design, so the top bar starts right
  under the inset whether iOS reports one (drawing behind) or not (its own strip).
- **Settings › Appearance** says it plainly: "On an iPhone with Nova on the Home Screen, a dark
  design also fills the strip with the time and battery. After you switch to or from a dark
  design, that strip may only change once you close Nova and open it again."

## Tests

- **Unit** (`tests/themes.test.js`, in `npm test`):
  - each built-in's declared value, and no status bar warning for any of them;
  - a package without the field fails `check:themes` but still applies, with `default`;
  - `translucent` over a light look, a wrong word, a missing or an extra key are refused; a dark
    design keeping the strip is a warning, said once;
  - `ui/index.html` carries the exact tag the server replaces; `statusBarTag` picks by mode.
- **UI gate** (`tests/ui/ios-status-bar.test.ts`, in `scripts/ui-test.sh`):
  - **per design**, in Chromium and WebKit: 20 design × mode × system-scheme cases, each checked as
    sent by the server, at first parse and once loaded (80 readings);
  - **live swap**, with no reload: for every device, this device only (and the next page as sent
    to that device, and to another browser), a mode change, and the system turning dark under Auto;
  - **safe area**, Chromium with emulated insets (iPhone 390×844 with 47 px top, iPhone 15 Pro
    393×852 with 59 px, iPhone on its side with 47 px sides and 21 px bottom), Orb Teal and
    Companion Light, on Home, Chat and Settings:
    - the shell keeps the top inset clear exactly once, and the top bar starts right under it;
    - the page starts at the top edge with its background painted there;
    - what is under the status bar is the page's background, never a control;
    - no control sits in any inset.
- The fold-postures gate (PR #267) and its baselines are unchanged and still pass. No baseline
  changed: the Settings shots open "You and Nova", not Appearance, and nothing moved.

## What can't be tested here

No test browser runs as an installed iOS app: Playwright has no standalone display mode, WebKit on
Linux reports no safe-area insets, and none of them has an iOS status bar. Whether iOS honours the
tag, and when it reads it again, can only be seen on a real iPhone.

**For the owner to check on the phone** (Nova on the Home Screen; remove and re-add it once first,
so it starts from this version):

1. **Orb Teal** (the default): Nova's teal reaches the very top of the screen, behind white time
   and battery. No empty band, and the top bar (title, buttons) starts just under the time, not
   under it and not far below it.
2. **Settings › Appearance → Companion Light**, for all devices or this device. Close Nova fully
   (swipe it away) and open it again: iOS's own light strip is back above Nova, with dark time and
   battery, readable.
3. **Before re-opening in step 2:** note whether the strip changed already. Either is fine; it
   tells us whether iOS reads the tag only at launch, and so whether the Settings line is right.
4. **Aurora or Paper with Light and dark on Auto:** switch the iPhone to Dark Mode, re-open Nova:
   it draws behind the status bar. Back to Light Mode, re-open: iOS's strip.
5. **Turn the phone on its side** in Orb Teal: nothing under the camera cutout or the home bar; the
   rail and composer are fully tappable.
6. **Pull to the top of Chat and of Settings** in Orb Teal: nothing scrolls up under the time and
   battery in a way that looks broken. (The scroller is below the top bar, so it shouldn't.)

**A design for this device only:** the server knows a device's appearance id only from a
first-party cookie (`nova-appearance`, SameSite=Strict) that `theme.js` sets once the app has
loaded. So the first launch after this change, or after site data is cleared, sends the person's
design's words, and the app corrects the tag a moment later; every launch after that sends the
device's own. If iOS reads the tag only at the first parse, that one launch shows the person's
design's status bar. Step 2 with "This device" checks it.

## What changed (plain language), for the LEDGER entry

- What changed: on an iPhone with Nova on the Home Screen, the dark designs (Orb Teal, Nova,
  Obsidian, and Aurora and Paper in dark mode) now fill the top of the screen behind the time and
  battery, so there's no empty band above Nova. The light designs keep iPhone's own strip, because
  iPhone would make the time and battery white there, which you couldn't read on a light page.
- What you can now do: use the installed app edge to edge in a dark design. Settings › Appearance
  tells you that after switching to or from a dark design, you may need to close Nova and open it
  again before the top of the screen matches.
- Still unfinished: checking it on your real iPhone. The tests can check the setting Nova sends
  and that nothing sits under the time or the home bar, but no test browser runs as an installed
  iPhone app.
