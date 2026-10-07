# S38 carries

These items came out of the task reviews and the final whole-branch review, and were judged safe to ship (final-review rulings, 2026-10-06). None of them leaks a credential to her or adds an approval. Each guard item is a **miss** (the safe direction), never a false correction, unless it says otherwise.

## The guards (browser rows and claims)

- **The address-substring match is loose.** "I opened https://ample.com/" is backed by an open of example.com, because the last segment is matched as a substring.
- **A download claimed after an unrelated tool isn't judged.** Once any tool has succeeded this turn, a made-up "I downloaded invoice.pdf." is not checked (the fix-round-1 I1 trade-off).
- **Only known file extensions are judged in a "downloaded" claim.** `.zip`, `.png` and "the README" are not checked.
- **A curly apostrophe ("can’t") is missed.** This is true across the whole guard family (G24); fix it once, in the shared code.
- **"…because I'm a language model" stands.** Any "because" or "since" tail is read as a real limit in every capability row.
- **A metaphor fires.** "I clicked through the links in the docs you gave me." gets a browser_acted correction when no browser tool ran.
- **A typing act with no page fact keeps an "I'll open that page" promise.** This is the same looseness `fetch_url` has.

## Text a page or the engine chooses

- **The page fact's address is not clipped.** It reaches turn_spans and Activity only, never her context, which gets the clipped address. The guards back "I opened <url>" by its last path segment. Fix: store a head-and-tail form (the first and last ~1,000 characters).
- **browser_read's result_head can carry a page link's query (G33).** Fix: scrub result_head for browser spans.
- **A dialog bullet cannot be told from page text.** The engine writes the page's message raw into it, so forged entries are bounded (40-character kind, 3 dialogs), not refused.
- **A raw NEL (U+0085) before `[e99]` reaches text she sees**, and `str.splitlines` treats NEL as a line break.
- **The `[eN] generic:` block has no end marker**, so the next sibling's lines read as if they were inside the card.
- **Outline counts are substring counts over the rendered text.** Count per node while rendering instead.
- **A text value with a control character is written as `\xNN`**, which JSON rejects; the fallback shows every escape raw.

## The agent and the engine

- **`agent.seeded` is not written in `agents.create`'s transaction.** A crash between the two records `made=False` for an agent this code made, and one narrow window can re-make a deleted agent. Fix: write the event in the same transaction.
- **A stale tool in the seeded agent's spec loops a traceback.** If the spec ever names a tool that is no longer registered, the scheduler logs a traceback every tick.
- **The engine's endpoint is reachable from a page in its own container** (`127.0.0.1:8931`, `browser:8931`). The engine sends no CORS headers and needs a session-id header, so a page should not get a session, but this is unmeasured. Probe it in the walk.
- **Dismissing a file chooser uses the engine's documented cancel**, which has not been seen working yet.

## Hygiene

- **The module docstring of `app/addresses.py` still describes the old two-scheme search** as history.
- **`test_model_speed.py` has 12 asyncio-mark warnings.** They predate this slice and are not in its diff.
- **The backup shell test fails 3 restore-listing cases.** The failures predate this slice, are identical on main, and are fixed on `slice/s42b` (LC_ALL=C on `comm`).

## Checked in the walk (Task 11)

- **393 px:** the Routing row for `agent_browser`.
- **The carried Chromium profile** still opens after the container is recreated (new hostname) and after a restore.
