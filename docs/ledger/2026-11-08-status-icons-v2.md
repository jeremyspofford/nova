**2026-11-08 · Design system · Status icons v2 (owner review fixes)**
- What changed: six fixes from the owner's review of v1 (#381) against the state sheet.
  1. Scale: large forms fill about 95% of the canvas, roughly 90% of the tile, like the sheet.
  2. Idle: two broad arms along the upper-left to lower-right diagonal, each swelling from a fine tip at a small dark centre to a fat outer lobe. At rest, an eased half-turn every 10 s.
  3. Listening: a full, closed, tilted ring, broad on one side and fine on the other. Its broad side orbits with an eased turn every 8 s.
  4. Stopped: heavier, S-curved crossed ribbons. All six colour stops are shades of status/error, down to 45% brightness, so it reads deeper red with no hardcoded colour and no token change. Small sizes get a wider band to keep their mass. It reads as an X at 16 px in greyscale.
  5. Glow: about 2.4× tighter and roughly half as strong. The ribbon body is solid and brighter, with a 1.25× saturation lift.
  6. Timing: MORPH_MS is 800 on a sine ease-in-out. Ambient loops ease in and out to rest: thinking 7 s, listening 8 s, idle 10 s. Working stays brisker.
  - SUCCESS_MS is 1800 (an 800 ms morph in, then about a second shown).
  - The preview's success replay runs every 3.4 s.
  - Seams on the closed loops (listening's ring and needs-you's triangle) are fixed.
  - The service worker cache moves to v52.
- What you can now do: see status icons that fill their tiles, read at a glance, and move slowly and smoothly.
- Still unfinished: two things.
  - Idle reads closer to an S than the sheet's closed vortex.
  - The sheet's over-and-under ribbon twists and fine glossy highlights aren't reproduced.
- Checked: locally, before CI.
  - lint:tokens and typecheck.
  - status-icon, styleguide-coverage and m9-wait unit tests (22/22), with new tests for the 800 ms timing and eased loops.
  - tests/ui/status-icon.test.ts: three runs in a row, 4/4 each.
  - theme-match: 1/1.
  - Screenshots, including the idle → working → idle frame sequence, are in docs/screenshots/status-icons-v2-2026-11-08/.
