**2026-11-10 · Memory · Recalled notes are read again before every step (A-023)**
- What changed: a turn searched memory once, before its steps, and gave every model call the same snapshot, so a note forgotten mid-conversation still went into the next prompt and its receipt. Before each step the recalled notes are now read again from their day files: a forgotten one drops out, an edited one goes in as it is now, and the receipt lists what was actually sent.
- What you can now do: forget a note while Nova is working and know the next step won't use it.
- Still unfinished: the turn doesn't search again for new notes mid-turn (only what it recalled is kept current). Notes forgotten from backups are Batch 2's next items.
- Checked: a test forgets a recalled note between the first and second model call. The second prompt has no trace of it and still has the other note. The same test on the old runner fails ("the next step never sees a forgotten note"). Full suite passes.
