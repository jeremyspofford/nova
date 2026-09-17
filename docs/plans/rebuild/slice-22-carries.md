# Slice 22 — carries

Open items from S22 (live resources). Each is a fact about what is NOT
done, so a later slice starts from the truth rather than from a
re-discovery.

## DEFERRED: the last two walk steps

Deferred by Jeremy, 2026-09-14: "Put the 'ask her about the gpu once the
game's off' for later."

Everything in S22 is built, tested and deployed, and the walk has already
paid for itself once — it killed the slice's premise and bought the stalled
half of the check (see the slice doc). What is left needs a turn the model
can actually answer, which needs the card free.

1. **Ask her about the GPU, in chat, in his own words.** Then read
   `turn_spans` for that turn: `inference_health` should appear as a tool
   span, and the reply should carry the card's real numbers. Curling the
   route proves nothing about her — the whole point is whether the model
   reaches for the tool when the question is about the GPU.
2. **Confirm the Inbox item.** One walled round is on record; the check
   needs two in the recent window (`model_speed.MIN_STALLED_ROUNDS`). If a
   second turn walls while he is playing, the next beat should raise
   `inference_stalled:qwen3.8:27b` naming both the walled count and how
   much of the card is held by something that is not ollama. It should fold
   rather than repeat on the following beat, and clear when the card frees.

Neither needs code. Both need the owner's own session, which is the point.

## PARKED (owner, 2026-09-15): S23, the serving runtime

`docs/plans/rebuild/slice-23-serving-runtime.md`. Nothing built. Listed here
because a parked spec that is not in this file is invisible — which is
exactly what happened to the corpus TODO below, and what happened to the S23
spec itself on the day it was written: it sat on an unmerged branch and the
owner could not find it.

Every number in it was measured on this host, so it does not rot. The first
move on any pickup is one cheap experiment, not a migration: does
`LLAMA_ARG_CACHE_RAM` reach ollama's llama-server child the way
`LLAMA_ARG_KV_OFFLOAD` was proven to?

## SCHEDULED LAST (owner, 2026-09-16): S27, feature flags

`docs/plans/rebuild/slice-27-feature-flags.md`. Nothing is built. It was
designed with the owner on 2026-09-16 and placed last in the order of work
(decisions-2026-09-15.md, "Order of work", item 5).

It is listed here for the same reason S23 is. Its spec first sat on an
unpushed branch, and another session wrote a separate flag design the same
day (`feature-flags.md` on `slice/s24`). That session withdrew it in S27's
favour once it found the branch.

The first move on pickup is a discussion, not code: whether flag-first
development can be guaranteed without fail, for Nova and for Claude sessions
(decisions-2026-09-15.md, item 10).

## TODO (owner-requested, unscheduled): a broader AI-quality corpus

Asked for by Jeremy on 2026-09-14, in his words: "add a todo to make more
general tests for the ai quality runs so that we can have a good idea of
its quality and capabilities."

**Recorded here on 2026-09-14 because it was not recorded anywhere.** It
was agreed in a session that has since been compacted, and a promise that
lives only in a transcript does not exist. That is the whole lesson: it
took a "what's next?" to notice it had evaporated.

**What exists today.** `agent_quality` is 23 cases and every one of them
is a HONESTY or CONTRACT pin — did she call the tool, did she avoid
claiming a thing she did not do, did the guard fire. That is what the
corpus was built for and it does it well. It says almost nothing about
whether she is any GOOD: whether she reasons, whether she writes well,
whether she can hold a long context, whether she picks the right approach.

**What it is for.** Choosing a model. The 27B scores 21/23 and the 8B
19/23, which reads as "nearly the same" and is almost certainly false about
capability — the two-case gap is honesty pins, not intelligence. Without a
capability half, the suite cannot answer the question he actually asks it,
which is "which model should Nova run".

**Known hard part, stated so it is not re-discovered.** Mechanical
predicates (`tool_called`, `reply_matches`) cannot grade reasoning or
prose. Grading those means either a judge model — which v3 did, and which
brings position bias, its own model's taste, and a second thing to trust —
or hand-written rubrics that go stale. This is a design decision to make
deliberately, not a corpus to start typing.

## CARRIED IN from earlier slices, still open

- **S16's claimed-deletion eval case.** Needs a workspace-file fixture in
  the harness; cases can declare `agents` and `skills` today but not files.
- **`no-fabricated-agent-work` is unstable on both models** (2/3). Reads
  like the other ambiguous cases and deserves the same treatment.
- **A matched three-run set for the 27B under the warm-up code.** Two of
  its three recorded runs predate the S21 warm-up, so the floor across runs
  is not strictly comparable.

## OUT OF SCOPE, deliberately, and why

- **Routing around a contended card.** Falling back to a smaller model when
  the GPU is busy is a decision on his behalf, and S10's mode switch is
  where that belongs. S22 states; it does not decide (owner ruling
  2026-09-03). The 12th and the 14th are the argument for having that
  conversation, not for skipping it.
- **The ollama runtime knobs** — `OLLAMA_MAX_LOADED_MODELS`, KV-cache
  quantisation, a context cap, the Windows sysmem-fallback policy. The
  audit found every one unset. Each is a real trade-off and a separate
  conversation, not a side effect of this slice. On a machine routinely
  6 GB down this is plausibly the cheapest fix for the actual problem.
- **The 300 s gateway timeout.** It bounds silence and is doing its job;
  the problem was never that it fired.

## CLOSED 2026-09-15: S22's own measurement was reading a fiction

Found by answering the owner's question — "why do Nova responses take so
long?" — with the trace rather than a guess. Three compounding faults, one
of them S22's.

**1. The reasoning stream was dropped entirely.** qwen3 thinks by default.
ollama streams that thinking in a `reasoning` field with `content` empty on
every chunk, and `chat._chunk_parts` read only `content`. Probed directly
against the live ollama for "what is 2+2? Answer in one word":

    chunk 1 {"role":"assistant","content":"","reasoning":"Okay"}
    chunk 2 {"content":"","reasoning":","}
    data lines: 59   elapsed: 146.6s   first CONTENT delta: never

So the owner watched an empty bubble for the whole time she worked, and a
round whose token budget went entirely on reasoning was reported as "the
stream ended with no content" — the same sentence a dead backend produces,
wanting the opposite response.

Four ways of switching thinking off were tried against this ollama on the
`/v1` path: `think: false`, `chat_template_kwargs.enable_thinking`,
`/no_think` in the prompt, and as-sent. **All four still thought, and all
four produced zero content at `max_tokens=80`.** It cannot be turned off
here, so it has to be read.

**2. `tok_per_s` was arithmetically impossible.** Generation was measured
from the first CONTENT delta, so the window excluded every reasoning token
while `completion_tokens` counted them. Live spans carried 1 777, 1 918 and
1 927 tok/s on one 24 GB card. `inference_degraded` reads that field: it was
reading a number that could only ever point upward, which is the direction
that never raises a finding.

**3. Most rounds recorded no rate at all.** A round that only calls tools
emits no content, so `t_first_delta` stayed None for the whole round and
`_note_throughput` returned early. `model_speed`'s query skips a span with
no rate, and tool rounds are most of a working turn — so the evidence never
reached the median. At 21:05, with the card pinned at 99% and turns taking
100-400 s, the beat said:

> inference_degraded — no model has both recent rounds and enough history to
> compare them against, and none has stalled — nothing to measure

Both (2) and (3) are one fix: **prefill ends at the first token the model
emits, of any kind** — content, reasoning, or a tool-call fragment. No
threshold was loosened; the data was wrong, not the rule.

Also shipped: `prefill_ms` / `thinking_ms` / `ttft_ms` as three separate
fields (they answer three different questions), a `{"think": …}` stream
frame so a long think reads as work rather than as a hang, a failure
sentence that distinguishes "thought and never answered" from "produced
nothing", and `utilization.gpu` on the card reading — the card had 6.9 GB
free and was 99% busy, and free memory alone describes that as healthy.

### Still open from this
- **The contention itself.** A process outside every container held ~7.3 GB
  and 99% of the shader cores. That is the third time (2026-09-12,
  2026-09-14, 2026-09-15). Nova can now SAY it; nothing stops it.
- **Thinking cannot be disabled on the `/v1` path.** If a fast path matters
  more than reasoning quality for chat, that needs `/api/chat` — which is a
  gateway change, not a core one, and a real decision rather than a fix.
