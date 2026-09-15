# Slice 23 — the card decides the context, not a constant

Branch `slice/s23` in `.worktrees/s23`, cut from `rebuild/v4` at 4af2ad8a.

**Rewritten 2026-09-15** after Jeremy asked the better question: "could this
be fluid/dynamic — when a model is loaded, if there isn't enough headroom,
Nova could dynamically change to a similar model family but a slightly
smaller size, configure its context size, etc.? That way nothing is on the
user to decide and manage."

The first version of this spec was four knobs in a compose file and four
decisions for him to make. Everything measured since says that was the
wrong shape.

## What the measurements say (2026-09-14 and 09-15)

### 1. Nobody chose the context, and it is the biggest number on the card

`deploy/docker-compose.yml` gives ollama no environment block, so
`OLLAMA_CONTEXT_LENGTH` is unset and ollama serves **32768** — its own
default. `qwen3.8:27b` declares 262144; the 8B declares its own. Neither
number is 32768. The most expensive runtime property on this host is a
default no one looked at.

### 2. The cost of context is per-model, and it is large

Measured on the live card, same model, four loads (`/api/ps` `size_vram`):

    qwen3:8b    32768 ctx -> 9.28 GB      (4.9 GB of weights)
                16384 ctx -> 7.00 GB      saves 2.28 GB
                 8192 ctx -> 5.86 GB      saves 3.42 GB
                 4096 ctx -> 5.20 GB      saves 4.08 GB

    qwen3.8:27b 32768 ctx -> 16.6 GB      KV = 2.0 GB of it

**The 8B's KV cache at 32k is 4.1 GB — most of its own weight again. The
27B's is 2.0 GB.** Same context, half the cost, because the 27B is an MoE
with 16 KV layers and the 8B is dense with 40.

That kills the original spec's centrepiece. One global
`OLLAMA_CONTEXT_LENGTH` applies the same number to models whose cost for it
differs by 2x, and no single value is right for both.

### 3. Context IS settable per request — but not on the path we use

    POST /v1/chat/completions  {"options": {"num_ctx": 4096}}   IGNORED (-c 32768)
    POST /api/chat             {"options": {"num_ctx": 4096}}   HONOURED

Verified by reading `/api/ps` back: it reports `context_length: 4096`. The
gateway's ollama adapter posts to `/v1/chat/completions`, so today Nova
cannot ask for a context at all. `/api/ps` also carries `context_length`,
which answers the old spec's open question about where visibility comes
from.

(The memory note `local-model-thinking` already wanted `/api/chat` for a
different reason — `/v1` ignores the `think` parameter too.)

### 4. Two knobs I was wrong about

**Flash attention is already on.** `OLLAMA_FLASH_ATTENTION` reads `false`,
which is what I would have "fixed", but llama-server runs `--flash-attn
auto` and logs `Flash Attention enabled`. Setting it changes nothing.

**KV cache type has no per-request form.** `OLLAMA_KV_CACHE_TYPE` is
server-level only, so it stays in compose — the one knob that genuinely is
static configuration.

## The answer to his question: yes, and context is the better lever

Swapping to a smaller model is the blunt version of this, and it should be
the LAST resort rather than the first. Context is a continuous dial that
costs gigabytes, and it can absorb a shortfall without changing which model
answers — no voice change, no capability change, nothing to explain.

And there is a stronger move available than "fit the biggest context that
fits", which is what makes this genuinely automatic:

**Size the context to the TURN, not to a constant.** Nova builds the
messages, so it knows how big the prompt actually is. A turn with 3k tokens
of prompt does not need a 32k KV cache; it needs about 4k. On the 8B that
is 5.2 GB instead of 9.3 GB — a 4 GB saving on a turn that lost nothing,
every turn, whether or not anything else is on the card.

So the ladder, in order, and each rung only reached when the one above
cannot work:

1. **Size the context to the turn.** Prompt tokens + room for the reply,
   rounded up to a sane step. Almost always enough on its own.
2. **Cap it to what the card has free.** S22 already reads free VRAM live
   (`/admin/vram`). If the turn's natural context does not fit, serve the
   largest step that does, and SAY the history was trimmed.
3. **Step down the model.** Only when even the floor context will not fit.
   Same family, next smaller by MEASURED size — derived from the live
   catalogue (`facts.size_bytes`, `family`, `params_b`), never a hand-kept
   ladder.
4. **State that nothing fits.** Never silently answer on a model he did not
   choose without saying so, and never pretend a card that cannot serve
   anything can.

## What this costs him: one choice, not four

Not four knobs. One setting with three positions, and a default:

    inference.when_the_card_is_busy
      "trim"     size context to the turn and to the card   (default)
      "step"     also step down a model size when needed
      "hold"     never substitute; slow down or fail, and say so

`"trim"` is the default because it never changes which model answers.
`"step"` is the thing he asked for and it is opt-in, because a substituted
model is a different Nova. `"hold"` exists because someone measuring a
model wants the model they named — the eval harness must pin it (rail 17:
"a measurement on a substituted model would be a lie about which model was
measured").

**The eval runner always behaves as `"hold"`, regardless of the setting.**
Not negotiable: a suite that quietly scored a smaller model would poison
every comparison in the corpus.

## The honesty problem, which is the real risk

A silent downgrade is exactly the failure class v4 exists to prevent. If
she answers on `gemma4:12b` when the chat model is `qwen3.8:27b` and says
nothing, the trace and the reply disagree — the `nova-forged-tool-receipt`
shape, one layer down.

Mechanically, not by prompt:

- The `llm_call` span records `model_requested` beside `model`, and
  `fit_context` beside both. The trace already carries `served_by`.
- A downgrade sets a turn-level fact the reply is composed WITH, the same
  way S22's stated refusals work — so "I answered on the 12B because the
  card had 6 GB taken" is something she can say because it is true and
  handed to her, not because a prompt asked her to be honest.
- A guard: a reply that names the requested model as the answering model
  when the span says otherwise is a state claim about the present that is
  false. This is `guards.py`'s existing shape.

**This is the part that needs your ruling.** Three options, and I do not
think it is my call:

- **(a) Always say it.** Every downgraded turn carries a visible line. Most
  honest, slightly noisy.
- **(b) Say it once per conversation**, then leave it in the trace and the
  Inbox. Quieter, and the fact is still never hidden — it is just not
  repeated.
- **(c) Never volunteer it**, but never deny it either: the trace has it,
  `inference_health` reports it, and a guard catches a false claim.

My recommendation is **(b)**. (c) meets the letter of the honesty rule and
violates its spirit — he would find out his assistant had been quietly
demoted for a week by reading a span.

## What gets built

**A. The adapter speaks ollama's own language.** `/api/chat` instead of
`/v1/chat/completions` for the bundled engine, because `/v1` cannot carry
`num_ctx` (measured above). This is the enabling change and it is the
riskiest part of the slice: the streaming shape, tool calls and the usage
chunk all differ between the two, and S10's metering reads that chunk. It
needs its own careful pass.

**B. `gateway/app/context_fit.py`** — pure, given (prompt size, model's KV
cost per 1k, free VRAM, floor and ceiling), returns a context step and a
reason. Testable with plain numbers, no I/O, like `fit.py`.

**C. The KV cost per model is MEASURED, not assumed.** The 2x difference
between the 8B and the 27B is exactly what a hardcoded constant would get
wrong. `/api/ps` reports `size_vram` at a known `context_length`, so two
observations of a model give its slope. Recorded per model, derived from
rows this system already writes — the S22 pattern.

**D. The ladder, derived.** Same family, next smaller measured size, from
the live catalogue. No hand-kept list to go stale.

**E. Visibility.** `/admin/vram` gains the serving context; the span
carries requested-vs-served; `inference_health` says both.

**F. The static knob.** `OLLAMA_KV_CACHE_TYPE=q8_0` in compose (halves what
is left of the KV, no per-request form), `OLLAMA_MAX_LOADED_MODELS=1` (a
second 17 GB model on a 24 GB card is an OOM nobody chose),
`OLLAMA_KEEP_ALIVE` left at 5m deliberately. Pinned by a tripwire test.

## Definition of done

- A turn with a small prompt serves at a small context, measured on
  `/api/ps`, with no loss of answer quality.
- With the card squeezed, a turn that would not have fitted answers anyway,
  and the trace says at what context.
- Under `"step"`, a turn that cannot fit at any context answers on the next
  model down AND says so.
- The eval runner pins its model regardless of the setting.
- `test_no_approvals` still passes: none of this asks him anything or
  refuses on his behalf. It adapts and reports.

## What would make this wrong

If sizing context to the turn hurts answers in a way the corpus can see.
Trimming history is a real cost and this slice trades it for headroom
deliberately. The corpus is the instrument: run it before and after at the
same suite version, on the same model, and if the score moves the trade is
not free and the defaults change.
