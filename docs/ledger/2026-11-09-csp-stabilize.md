**2026-11-09 · Tests · Three intermittent UI-gate failures after the CSP, fixed at their causes**
- What changed: main went intermittently red after #401.
  - Shots, caused by the CSP: Playwright re-evaluates a string waitForFunction predicate in the page on every poll after the first, which the CSP refuses. shots.js:583 and :591 now use function predicates, and no other string predicates remain. The CSP PR passed only because its reply was on screen at the first check.
  - Jarvis rings, a race: the styleguide's appearance-driven redraw could replace .jv-hero after settled(). The page now sets html[data-sg-appearance] once the redraw is done, and the test waits for it.
  - passkey-flow on WebKit, not the CSP (same origin, and not WebKit's connect-src wording): most likely an API read cut by navigation. A quietNavigation helper waits until no API read is in flight before navigating.
- What you can now do: rely on main's UI gate again, without timing luck.
- Still unfinished: one thing. The passkey-flow fix rests on a likely cause; it never failed locally, so CI repeats are the proof.
- Checked: local repeats. shots 3/3 (133/133 each), jarvis-rings 5/5, passkey-flow 5/5 in both engines, csp 1/1, typecheck.
