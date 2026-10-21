# Phase 2: experience review

Phase 2 makes memory something you can see and steer. Nova keeps durable
facts, preferences, decisions and corrections in `MEMORY.md`, and day detail
in dated notes. Both are written before each reply finishes. The Memory view
shows what Nova knows and where each entry came from, and lets you edit or
forget any entry with one gesture. Evidence comes from `npm run shots`
(39 of 39 checks, [results](screenshots/results.json)), `npm test` (50 pass),
and two turns against the real `claude -p`.

## How memory is kept

- The model ends its reply with memory blocks. `<remember kind="…">` adds an
  entry, `<remember replaces="id">` corrects one, `<forget id="…">` removes
  one, and `<note>` adds day detail. Nova strips them from the reply while it
  streams, so they never flash on screen. It applies them before marking the
  reply done; the walkthrough checks the log order (memory, then done). This
  costs no extra model call.
- Each entry is still a plain markdown bullet, and keeps its source in a short
  trailing comment:
  `- Takes coffee black. <!-- id=m61b9c064 from=<conversation>/<turn> at=… -->`.
  Bullets written by hand work too.
- A correction replaces the old entry in place, keeping its id, so there's no
  second, conflicting line. Checked in the walkthrough and in unit tests.
- Real model, two turns:
  - Turn 1: "black coffee, Lisbon in March" became a preference, a fact and a
    day note.
  - Turn 2: "Actually oat milk lattes; forget the Lisbon trip" replaced the
    preference and forgot the trip along with its day note.
  - Each turn took about 2.5 s end to end.
- Session logs record memory changes by id only, never the words. A memory
  you forget doesn't come back through an old conversation.

## Every state designed

| State | What you see | Evidence |
| --- | --- | --- |
| Nothing kept yet | What will appear here, and that you can change it | [paper-memory-empty](screenshots/paper-memory-empty.png) |
| Kept, in the conversation | A margin note, "kept in memory: …", linked to the entry | [paper-memory-chat](screenshots/paper-memory-chat.png) |
| Corrected | "corrected in memory"; older notes read "kept in memory, since changed" | [paper-memory-chat](screenshots/paper-memory-chat.png) |
| Memory view | Facts, Preferences, Decisions, Commitments, then day notes; each entry says where it came from | [paper-memory](screenshots/paper-memory.png) |
| Editing | The entry becomes a field in place; Enter saves, Esc cancels | [paper-memory-edit](screenshots/paper-memory-edit.png) |
| Forgotten | It goes at once; a toast offers Undo for 8 seconds | [paper-memory-forgot](screenshots/paper-memory-forgot.png) |
| Forgotten, seen from the conversation | "kept in memory, since forgotten", with no text | walkthrough check |
| Server unreachable | "Memory couldn't be read", with Try again | `renderMemoryView` |
| Mobile | Same view; actions always visible on touch | [mobile-memory](screenshots/mobile-memory.png) |
| Themes | Paper dark, Aurora, Aurora dark and Obsidian | `*-memory.png` |

## Forgetting

Forget removes the entry from `MEMORY.md`. It also removes the day notes that
say the same thing: notes from the same exchange that share a word, or notes
elsewhere that share most of its words. Without that, search could bring the
memory back. The toast says how many notes went with it. Undo restores all of
it in its original place.

**Still open: your call on git history.** The home folder commits after every
change, so older commits still hold forgotten text. I recommended rewriting
that history on Forget. The build environment blocked me from writing
history-rewriting code without your explicit go-ahead, so it isn't built.
What ships deletes the text from the files only, and the toast and README
don't claim more than that.

## Motion

- Leaving entries fade (`--m-med`).
- The toast rises (`rise`).
- An entry reached from a link, or a turn reached from "from …", gets a
  brief accent wash (`found`) that fades out.
- Nothing new moves under reduced motion: `rise` drops to a crossfade, as in
  Phase 1.

## Typography and spacing

- Token lint is clean (13 files).
- Section labels reuse the sidebar's caption style.
- Kind descriptions and day headings reuse the margin (italic serif) voice.
- Entries use body text, and sources use callout.
- The style reference shows the memory view, a kept margin note and the
  toast.

## Keyboard

| Key | Does |
| --- | --- |
| Tab (on arrival) | First memory |
| ↑ / ↓ | Previous / next memory |
| Enter | Edit; Enter again saves, Esc cancels |
| Delete or Backspace | Forget |
| ⌘/Ctrl+Z | Undo the last forget |

The walkthrough does edit, forget and undo by keyboard only.

## Budgets

| Budget | Measured |
| --- | --- |
| Cold start | 130 ms server + 141 ms page |
| Send → visible feedback | 6 ms |
| Scrolling: Nova's work per frame | p95 3.7 ms, max 6.4 ms |
| Memory write | about 5 ms between the reply text and `done` in the log (real model) |

## Copy

- Empty: "Nothing kept yet." Then: "As you talk, Nova keeps what lasts here."
- Intro: "Nova reads this before every reply. Change anything, or forget it."
- Kinds:
  - Facts: "Who you are and what is true about your life."
  - Preferences: "How you like things done."
  - Decisions: "What you settled, so it stays settled."
  - Commitments: "What you or Nova said would happen."
- Toasts: "Forgotten, with 1 day note that said the same." / "Back in memory."
  / "Saved. Nova will use it from the next message."

## One more thing

Every memory can show you the moment it came from. Click "from “I take my
coffee black…”" and Nova opens that conversation at that exact exchange,
which glows for a moment. It works the other way too: the margin note on the
exchange opens the entry in Memory.

## Decisions for you

1. **Git history on Forget** (the card in the thread). See above.
2. `write_file` can no longer touch `MEMORY.md` or `memory/`. Memory changes
   only through memory blocks, so every entry keeps its id and source.
3. Today's and yesterday's notes are now read into every conversation, so a
   day carries across conversations. Older notes are found by search.
4. Day notes are a record of the day, so a correction doesn't rewrite them.
   For example, the "black coffee" note stays after a switch to oat milk.
   Forget removes them.
