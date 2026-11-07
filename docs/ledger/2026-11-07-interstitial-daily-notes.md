**2026-11-07 · Interstitial Research · Today's notes count as your own text, as MEMORY.md does**
- What changed: #365 made a research search that carries a distinctive word from MEMORY.md "personal-derived", so the outbound check is told before it decides. But every prompt also carries yesterday's and today's notes (memory/YYYY-MM-DD.md), and a word from those still went out as "public". They now count the same way. Their words stay in the run's state only.
- What you can now do: nothing new; the skill's switch stays off.
- Still unfinished: the word match is a heuristic (see #365).
- Checked: a new test in tests/ingest/interstitial.test.js (a word from today's note makes the search personal-derived; it never leaves). Lint, typecheck and npm test ran in iso.sh.
