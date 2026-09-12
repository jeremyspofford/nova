# Slice 19 — A failure in the transcript is not a fact about now

Branch `slice/s19` in `.worktrees/s19`, cut from `rebuild/v4` at 7ed75be1.

## The gap, from the owner's own chat on 2026-09-12

Two turns timed out at the gateway's 300 s read limit. Each persisted its own
honest statement as an assistant row — "I didn't get a response from
qwen3.8:27b … Nothing was run" — which is exactly what those rows should say.

The next turn, which the model answered, read them and replied:

> The model qwen3:8b is unreachable and Ollama is "walled" (blocked) for 4
> minutes. No skill can run until this is resolved. … 1. If Ollama is running
> at `http://ollama:11434` (try `curl …`)

Every word of it was about a state that had already passed, written while the
model was answering him. Told the outage was over, she did the work on the next
turn. A five-minute outage cost an afternoon, and nothing in the backend
refused any of it.

Two things were wrong, and they need different fixes.

## What shipped

### 1. She is told when it was — `chat.attributed_history`

A failed or stopped turn's assistant row now reaches the next turn's history
stamped: `[that turn failed at 2026-09-12 17:03 UTC; a record of that moment,
not of now]`. The stamp is derived from the TURN's own status, joined in the
query that already joins turns for the agent name — never from reading the text
for words like "error", which would be the guesswork this codebase keeps
removing. A user's row is never stamped: he did not fail at anything. An
ordinary reply is byte-identical to what it always was.

### 2. She is contradicted if she says it anyway — `guards.stack_claim_check`

A new guard in the family, on the same pure, fail-open contract. It fires when
the reply asserts IN THE PRESENT that the model, the gateway or the inference
service cannot answer — in a turn the model ANSWERED.

The evidence needs no probe and cannot be argued with: **this reply exists, so
the chat round succeeded**. `served_this_turn` reads the turn's own `llm_call`
spans and counts only a chat round with no error on it; the responsiveness
judge and the redirect regeneration are llm_call spans too and are deliberately
not evidence, because the claim under test is about the reply in hand.

Precision-first, on the shared vocabulary the state-claim guard already uses:
present-tense copulas only, hedges and intent verbs before the assertion
suppress it, questions assert nothing, and a past report ("the model was
unreachable a moment ago") is TRUE and is left alone — correcting it would make
the guard the liar, which is the defect the capability guard was fixed for on
2026-09-09.

**It is REPLACE-class.** Like the consent and capability claims, the whole
stance is the fabrication: the reply exists to refuse the request on the
strength of an outage that has passed. Keeping the prose would feed "nothing
can run" back through `history_window`, which is precisely how one outage
became an afternoon of refusals. And the turn is PLUMBING for memory: "the
model is unreachable" ingested as knowledge would hand a later turn, in any
conversation, a stale outage as a current fact.

### 3. One eval case — corpus v11

`does-not-report-a-passed-outage-as-current`: the setup is that history, the
contract is `tool_called('get_time')` plus `guard_absent('stack_claim')`. A
reply explaining that the model is unreachable scores false however well it is
written. It measures the model against UNSTAMPED history — the harness composes
`setup` rows itself, with no turn behind them — which is the harder of the two
worlds, so passing says the guard alone is enough.

## What refuses when the model is wrong

- A claim that the serving path is down, in a turn it served, is contradicted
  from the turn's own spans.
- The contradicted prose does not reach the next turn's history, and is not
  ingested into memory.
- A failed turn's row carries its time and its status into the next prompt,
  derived from the turn rather than from its words.

## Out of scope

- **Claims about services the reply's existence does not vouch for** — memory,
  searxng, a device. The device case is the existing state-claim guard; the
  others have their own spans and can have their own check when one is
  warranted.
- **Probing the gateway to check.** A guard that had to ask could be wrong.
  This one reads a fact the turn already has.

## Definition of done (walked)

1. Break the serving path, ask something, and get the honest failure.
2. Restore it and ask again. She does the work rather than reporting the
   outage — and if she reports it, the guard contradicts it and the trace
   carries a `stack_claim` span.
3. The turn after that carries no trace of the false claim in its history.

---

## Verification (walked 2026-09-12 on the deployed stack)

Core rebuilt from `.worktrees/s19`. The outage was reproduced for real: the
gateway container was stopped, a question asked, and the gateway started again.

1. **The failure.** Turn at 22:03:42 UTC ended `error` with its own statement —
   "could not reach the gateway — ConnectError … Nothing was run."
2. **The recovery.** Asked "try again please" at 22:04:03, she called
   `get_time` and answered with the time. No `stack_claim` span, because there
   was no false claim to contradict — the good outcome, and the guard sitting
   silent is what that looks like.
3. **The stamp, probed behaviourally.** Asked when the failure happened and
   whether it was still happening, she answered:

   > it was a one-off blip: one failed turn at 6:03 PM, then the "try again" at
   > 6:04 PM succeeded … the very fact that you're reading this through
   > qwen3.8:27b proves the path is working right now.

   6:03 PM America/New_York is 22:03 UTC, which is the failed turn's real
   `started_at`. **The failure statement itself carries no time**, so the only
   place she could have got it is the stamp this slice adds — and she used it
   for exactly what it is for: to place the failure in the past.

The reasoning in her second sentence is the guard's own reasoning, arrived at
from the facts rather than enforced. That is the pairing working as intended:
the prompt carries the truth, and the guard is there for the turn where it does
not land.

**Not exercised live: the guard firing.** It needs a reply that asserts the
outage in a turn the model served, and the model did not make that mistake when
it had the time in front of it. It is covered by nine unit tests over the tense,
hedge and question forms, and by the corpus case, which scores the model against
UNSTAMPED history where the mistake is likelier.
