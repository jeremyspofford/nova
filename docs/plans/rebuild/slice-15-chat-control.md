# Slice 15 — Chat control: queue, stop, progress, drafts

Plan: `~/.claude/plans/review-jeremy-s-chat-with-reflective-brook.md`
(approved 2026-09-11). Branch `slice/s15` in `.worktrees/s15`, cut from
`rebuild/v4`.

Jeremy asked for three quality-of-life fixes he had just hit himself, and a
review of his 2026-09-10/11 conversations for anything else worth fixing. The
review turned the three into four: the same two days contain a turn that stayed
open for ten and a half hours with no way to stop it, and he added stop to the
ask ("it would be nice to be able to cancel her 'turn' if I don't like the
direction she's working on").

The four are one feature. They are all the same missing idea: **the owner has
no control over a turn once it starts.** He cannot add to it, stop it, see
inside it, or keep what he typed while it runs. The only state the composer has
today is "Nova is busy, go away".

## What the transcript showed

Read from `nova_core`, conversation `323892b5-8c0a-405d-a6f2-9f043c5a2a51`
(`messages`, `turns`, `turn_spans`).

- Turn `149fa83f` (09-10 00:32) stayed open **10 h 33 m** and closed only when
  a core restart swept it. No reply. The question behind it — how much VRAM the
  machine has — he typed **three times** and never got answered, although
  `memory_recall` found the note that says 24 GB on the first attempt.
- Turn `7083f83c` (09-11 11:49), "can you pull gemma 4 26b-a4b", was still open
  twelve minutes into this review. Spans are written atomically at close, so an
  open turn is also invisible: nothing in the record says where it is stuck.
- The 09-09 `nomic-embed-text` pull ran 8 minutes and produced exactly one
  message, at the end, after Nova said "it'll run for a bit and report as it
  goes".
- `ChatPage` is a route element, so leaving `/chat` unmounts it and takes
  `ChatInput`'s draft with it.

## Decisions with Jeremy (2026-09-11)

- **Queue, not steer.** A message sent mid-turn is parked and runs as the next
  turn. Steering it into the running turn was considered and dropped: a round's
  tool calls run sequentially (`chat.py:1730-1733`) and a `model_pull` is ONE
  call, so there is no round boundary to steer into until the pull finishes —
  the two designs deliver at the *same instant* in the case that prompted the
  ask, and steering additionally means a second writer mutating a live turn's
  message list with no honest place in the transcript for the injected text.
- **An explicit Stop.** This is what steering was reaching for, and it is the
  only thing that makes a bad or hung turn survivable from the UI.
- **Ruling S2c-R1 is amended, not broken.** Its wording anticipated this: "with
  no explicit Stop yet, every disconnect means finish". A disconnect still
  means finish. Only an explicit POST stops a turn.
- **Scope stays at four.** Everything else the review turned up is recorded
  below as carries, for Jeremy to sequence.

## Carries — found in the same transcript, deliberately not this slice

- **One 502 walls a whole chain for 60 minutes.** A single `ReadTimeout` on
  `qwen3.8:27b` walled both links of the chat chain, so his retry 12 seconds
  later failed instantly with a wall of text naming two walled models. A wall
  earned by one refusal is not evidence about the second model.
- **`memory_backfill` returns `ok: true` having written nothing.** Two runs
  read 132 and 135 messages and "proposed 0 facts, wrote 0 notes"; the third,
  with a `steps` value the model raised by guesswork, wrote 40. Jeremy typed
  the same request three times across 19 minutes. A tool that no-ops and
  reports success is the defect CLAUDE.md names; the third reply admitted "my
  replies recited the same summary" while the tool did nothing.
- **The narration guard fires false retractions.** Two consecutive replies
  (11:45, 11:48) ended with "Correction: I did not read the spend ledger this
  turn" while their own body said "per my spend read above" — and the figure
  WAS in the `list_agents` result head. A false retraction of a true statement
  teaches the owner to distrust the honest ones.
- **No workspace delete.** "please delete @groceries.md" — she could list it
  and read it and not remove it, and said so: "there is no delete operation in
  my toolbox". The folder still holds `groceries.md`, four near-duplicate
  `kv_offloading*` files and an orphaned `agents/coder/` from an agent deleted
  on 09-08.
- **A pull of a tag that does not exist fails generically.** `gemma4:26b-a4b`
  is a registry 404; `gemma4:26b` exists at 18.6 GB and fits his 24 GB. The
  gateway preflight already reads the registry manifest
  (`services/gateway/app/admin.py:206-247`), so it could name the near miss.
- **Error text still sends him to Settings.** Both 09-10 failures ended with
  "check the model in Settings → Models", after he said on 09-09: "I don't want
  to check the model settings, or activity for results."
- **`money_daily_spike` has never once run** and says so, verbatim, about
  twenty times in the log: "the ledger's earliest day is 2026-09-08… a trailing
  mean needs at least 3". A check that cannot run yet should be quiet, not
  repetitive.
- **She lost her own action inside 48 hours.** On 09-09 she told him "`coder`
  was deleted earlier in this conversation"; on 09-11 she said "I have no
  record of when or by whom". That is S14's territory, not this slice's.

## What shipped

### The draft (item 4)

`apps/web/src/lib/storage.ts` — `readLocal`/`writeLocal`, the try/catch that
`AppLayout` and `theme-store` each inlined separately, with the rule that a
stored value which will not parse is treated exactly like an absent one (it is
data anyone can edit in devtools). `ChatInput` takes a `draftKey`, lazily reads
it, writes on every edit and clears it in `submit()` — the one place the input
was already cleared, so storage only ever holds text that was NOT sent.
`ChatPage` keys it on the conversation id, which is globally unique and so
already per person.

One case needed care: ChatPage resolves the conversation a tick after it mounts,
so the key ARRIVES where there was none. A naive reset would wipe anything typed
in that gap, so the composer adopts it instead.

### Download progress (item 3)

The channel already existed end to end (`ctx.progress` → an activity frame with
`detail` → `ActivityLine`). What was missing was a NUMBER: `ACTIVITY_REPORT_KEYS`
copies string values only, so the percentage lived in prose and nowhere a bar
could read it.

- `chat.ACTIVITY_REPORT_NUMBER_KEYS = ("percent",)` — one numeric key, clamped to
  0..100 in `_activity_frame`, with bools and non-finite values refused (a NaN
  would reach the browser as `null`; `True` is an int in Python).
- `models._progress_pct` is now the ONE percent computation, used by both the
  words and the frame, because the two formulas had truncated and rounded
  differently — the bar would have sat at a different number than the sentence
  beside it. The throttle is one frame per whole point reached (at most 100 for a
  whole pull) instead of every five.
- The frontend carries `percent` on the `activity` event and the `ActivityMarker`,
  and `ActivityLine` renders the existing `ui/ProgressBar`. **Absent means
  indeterminate, never zero**, and a failure draws no bar whatever the last
  progress frame said.

Generic by construction: any tool that reports a percent gets a bar.

### Stop (item 1)

The first design was `task.cancel()` on the turn's task. An adversarial review
killed it, and the two findings are worth keeping:

- `_run_turn` has four callers and three of them `await` it INLINE — the
  scheduler, the eval runner, and `agents.delegate_to_agent` **inside the parent
  chat turn's own task**. Cancelling the parent would have delivered the
  `CancelledError` into the CHILD's `_run_turn`, which would have written "the
  owner stopped it" into the agent's log conversation and returned normally while
  the parent kept running rounds and kept spending.
- A cancel landing before the task's first step never enters the `try`, so the
  `finally` never runs: `INFLIGHT` keeps the id for ever, `pending_turn` is true
  for ever, and the startup sweep excludes it by construction. That is the
  2026-09-01 defect the INFLIGHT design exists to prevent.

So Stop is COOPERATIVE:

- `traces.STOPPING` — turn id → the stated reason, process-local for INFLIGHT's
  reason, and `ask_to_stop` REFUSES for a turn not in INFLIGHT. A stop nothing
  would ever read is not recorded and not reported as done.
- `chat._stop_if_asked` is read at the three points a turn can act on it, all
  synchronous so none of them joins the dispatch funnel's await list
  (`test_no_approvals` pins that, and it stayed green): between rounds, per
  streamed delta, and inside the bound `progress` callback — which makes ANY tool
  that reports progress interruptible mid-call without knowing Stop exists.
  `tools.TurnStopped` passes through `dispatch` by a deliberate re-raise placed
  before its two handlers, so the model is never told its tool failed.
- One exit, `_end_stopped`: persist first, then emit, then close — the discipline
  every other ending here follows. The text already streamed is KEPT and the note
  appended, because that text is what the owner watched.
- `turns.status` gained `'stopped'` (migration 023). NOT `'interrupted'`, which
  means *no process was running it* — the sweep's word, and the scheduler attaches
  behaviour to it.
- `POST /api/v1/chat/turns/{id}/stop` waits `STOP_CONFIRM_S` for a terminal status
  and reports which it actually saw. A turn still running after that is reported
  as still running, naming what it is doing.
- The note never claims the work was undone: core stopped WAITING on the call, and
  whether a download kept going is outside what it can see.
- `GET /conversations/active` gained `pending_turn_id`, because the case that most
  needs Stop is a tab that RELOADED into a hung turn and has no meta frame.

S2c-R1 is amended, not broken: a disconnect still means finish.

### The queue (item 2)

Two defects, one table. The composer was dead while Nova worked; and nothing
stopped a second POST from opening a SECOND turn on the same conversation, with
neither turn seeing the other's message and two replies interleaving.

- Migration 024 `queued_messages`: `seq bigserial` for the total order
  (`created_at` ties inside one transaction, which is exactly the burst-of-typing
  case), and three CHECKs — a claim names its turn, claimed and cancelled are
  exclusive, and **every cancellation states its reason**.
- `queued.hold_conversation` takes a per-conversation `pg_advisory_xact_lock`.
  The old check was advisory: seven round trips separated reading "is a turn
  running?" from registering the turn, which is all the room a double tap needs.
- `chat._open_turn` is now the ONE place a chat turn is opened, used by the route
  and by the drain — `_run_turn`'s "there is no second path" promise extended to
  the preamble. The history window moved INSIDE the lock, since a window read
  before the gate can miss the previous turn's reply.
- `conversations.conversation_busy` is the gate, and reads `traces.DOING` as well
  as `INFLIGHT` — because INFLIGHT holds only the owner's CHAT turns, and a timer
  firing runs a turn in the owner's own conversation. The same widening fixed a
  live false tripwire: `has_pending_turn` used to log a WARNING about every
  scheduled turn as though it were an orphan.
- `has_pending_turn` now also covers an outstanding queued row. A reloaded tab
  polls on that flag; if it cleared between a turn closing and the drain opening
  the next one, the tab would stop polling and the queued reply would never land.
- `chat.drain_queue` runs from `_run_turn`'s finally for EVERY kind of turn, since
  any turn ending is what frees the conversation. Two drains racing one row is
  normal and harmless (`FOR UPDATE SKIP LOCKED` under the lock). A drain that
  cannot start its turn CANCELS the row with a reason, because nothing else is
  going to end and try again.
- **The startup sweep** (`queued.sweep_stranded`): a fresh process runs no turns,
  so a row left waiting would never be drained. It is cancelled with a reason the
  owner can read — and not silently sent, since the box may have been down for
  days.
- **The shutdown guard**: `chat.begin_shutdown()` before `drain_background()`,
  because a drained turn spawns another drain and a draining queue could hold the
  process past its grace period and be SIGKILLed mid-turn. Found a real trap while
  testing: the flag is a one-way latch on a module global, so anything that enters
  and leaves a lifespan in the same process poisoned every later turn's drain —
  silently, with only a log line. The lifespan clears it on startup and the test
  fixture does too. (The queue tests passed alone and failed in the full run; that
  is how it surfaced.)
- `DELETE /api/v1/chat/queued/{id}` reports from the row the UPDATE actually
  changed: a message the drain claimed a moment ago is already being answered, and
  200 over that would tell the owner it was withdrawn when it was not.

Frontend: a 202 is parsed as its own `queued` event (it is `ok`, so it used to be
read as an empty SSE stream and reported as interrupted). The store sends a
mid-turn message through its OWN fetch — `streamChat`'s events are written for the
row being filled, and feeding a `done` or an `error` from that request into the
reducer would settle or destroy the live turn's bubble. Accepted messages live in
`state.queued`, not in the transcript, so neither transcript-merging path can show
one twice or lose it; the server's list is adopted on every poll tick, because the
server is what runs them. The composer is live while a turn runs and says what
sending will do.

## Verified

Tests: 2452 core (`uv run pytest`, own scratch DB on `nova-scratch-pg`), 859
frontend (`npm --prefix apps/web test`), clean `ruff check` and `tsc -b`.

**The live walk, 2026-09-11.** `core` and `web` rebuilt from this tree into the
running stack (migrations 023 and 024 applied on startup), then driven through the
real routes as the owner. Jeremy's call to do it this way rather than by hand.

- **A real pull, with a real bar.** "can you pull qwen3:1.7b from ollama?" →
  `model_catalog_search`, then `model_pull` for 27 s, and **101 progress frames
  carrying a percent, one for every point from 0 to 100**, each with the byte
  counts beside it. Before this, the same pull produced one message, at the end.
- **A follow-up sent mid-pull.** `202`, one `queued_messages` row, and **no second
  turn** — the old behaviour was two concurrent turns with interleaved replies.
  The pull turn closed at 14:19:54 and the drained turn opened at 14:19:54: it ran
  `get_time` and answered, with nobody watching and nothing asked twice. The
  transcript reads user, reply, user, reply in order, and the row is claimed by the
  turn that ran it.
- **Stop, inside a running download.** Asked at 12.8 s while the pull was at 5 %,
  the turn ended at 13.1 s — about 300 ms. The route answered
  `{"stopped": true, "status": "stopped"}`, and the turn closed `stopped` with a
  visible persisted reply.
- **Stop, while she was still thinking.** The route answered `stopped: false`,
  named what she was doing, and the turn ended at its next step. Honest in the
  shape the design intended: it reports what it saw rather than the good case.

### Two defects the walk found that the tests did not

Both were in the notes rather than the mechanics, and both are the same species —
a sentence claiming more than was checked.

1. **A bar that stops moving.** The percent high-water mark was per TURN, so the
   first layer of a multi-blob pull silenced every layer after it: the bar reached
   a number and sat there while gigabytes kept arriving. It is per layer now, with
   a test using a two-blob script.
2. **A false uncertainty.** `where` was read from the turn's live "doing" map, so a
   stop landing at a round boundary named the last tool — which had already
   returned ok — and then said whether it finished was not something she could
   see. It also reported that call as having FAILED, because an interrupted span
   keeps the head pre-set before dispatch. `where` now comes from the raise site,
   the caveat rides only on a stop genuinely inside a call, and the interrupted
   call is dropped from the ran/failed clause.

### The browser walk

The draft, the queued chip and the Stop button live behind the sign-in page, so
they were driven with Playwright against the served `web` build — signed in
through the real form, then clicked. Eight checks, all passing, no page errors:

| Checked | Result |
|---|---|
| Draft survives Chat → Settings → Chat | kept, verbatim |
| The page really unmounted in between | the composer was absent on Settings |
| Composer usable while a turn runs | not disabled |
| It says the next message will be queued | the hint is shown |
| A second message shows as waiting | the chip carries its own text |
| The chip's ✕ takes it back | the chip goes, after the server agrees |
| Stop ends the turn with a note | "Stopped while writing the reply — …" |
| The note is not styled as a failure | tertiary text, no danger class |

The last two are the walk's own fix, live: the note said *while writing the
reply*, because that is where the stop actually landed, and it added no caveat
about a call it had not interrupted.

Two stop notes higher up the same transcript still read the old way ("stopped
while running model_catalog_search … before that, model_catalog_search ran"),
because they were written before the fix. They are worth leaving: they are what
the defect looked like.
