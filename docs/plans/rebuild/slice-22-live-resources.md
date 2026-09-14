# Slice 22 — The stack notices when the card is not there

Branch `slice/s22` in `.worktrees/s22`, cut from `rebuild/v4` at 8b8a8bb8.

## The gap, measured

On 2026-09-12 the owner played a video game on this machine. It held about
7 GB of VRAM and pinned the shader cores at 347 W. Nothing in Nova noticed.
What happened instead, over about six hours:

- Two of his chat turns timed out at the gateway's 300 s read limit and the
  model got walled. She then answered the next question out of that history and
  told him the stack was down while the model was answering her (fixed in S19).
- An eval suite scored ZERO of 23 cases in fifteen minutes before I killed it.
- His own suite run produced two ungradeable cases, each costing 300 s of
  silence, on the way to a two-hour run that could only ever produce
  twenty-three ungradeables.
- Ollama's own timing lines put generation at **0.25 tokens per second**. With
  the game closed the same model, same 32k context, measured **67.5**. A
  270-fold collapse, and the only thing the stack could say about it was
  "nothing arrived from the gateway for 300 s".

The product has a fit notion and it is decorative. `fit.free_vram_gb_for_switch`
subtracts only entries flagged `swappable: false`, and its own docstring admits
nothing in the system ever produces one — so free VRAM is identically total
VRAM, forever. Total comes from `data/hardware.json`, written once by
`install.sh` and never refreshed. The strongest thing the product says about
the 27B is a badge reading "tight fit — ~22/24 GB", a number nobody measured.

Meanwhile `admin._nvidia_smi_used_mb()` already runs `nvidia-smi` live inside
the gateway container. It is called once, after a probe load, to record a
footprint. The fit decision never calls it. **The capability is built and the
decision does not use it.**

## Decisions with Jeremy (2026-09-14)

- **No stale file in a live decision.** His words: "Nova should do the work
  ad-hoc to get the resources live, not read stale shit." `hardware.json` is
  the same shape that produced v1's false "No GPU detected" on a working 3090
  (archived as `gpu-detection-two-phase`), and v4 rebuilt it. It keeps exactly
  one job — suggesting a model tier during install, on a machine where nothing
  is running yet — and leaves every live decision.
- **Free memory alone would still have missed it.** The game took 7 GB, which
  matters, and it also took the compute, which no memory reading sees. The
  honest measure of "is this card available" is THROUGHPUT, and the stack
  already records it: every `llm_call` span carries `completion_tokens` and its
  own `duration_ms`.
- **State, never decide.** v4 makes no authorization decisions (owner ruling
  2026-09-03). Nothing here refuses a turn, falls back to a smaller model, or
  pauses a run on its own judgement. It says what is true, loudly, in the
  places he already looks.

## What gets built

### 1. The device, read live — `gateway/app/devices_vram.py`

One function, `read_vram()`, returning `(total_mb, free_mb, note)` from a
single `nvidia-smi --query-gpu=memory.total,memory.used,memory.free` call, with
the same timeout and the same degrade-to-None-with-a-reason contract
`_nvidia_smi_used_mb` already uses. No file, no cache, no "since install".

`fit.py` stops taking `total_gb` from `hardware.json` and `free_gb` from the
eviction fiction. Its three numbers become:

- `total_gb` — live, from the card.
- `free_gb` — live, from the card. This is the number that moves when a game
  is running, and the only reason the old one could not move is that nothing
  ever set the flag it subtracted on.
- `needed_gb` — unchanged in precedence (a measured probe beats the curated
  estimate) but the estimate now prefers the catalogue's OWN `facts.size_bytes`
  from ollama `/api/tags` over the hand-written `min_vram_gb`, because the
  bytes are a fact and the integer is a memory of one.

`free_vram_gb_for_switch` and its `swappable` flag are DELETED, not fixed. A
function whose docstring says nothing ever produces the input it branches on is
a function pretending to compute something.

`hardware.json` stays for `suggest.tier_for_vram_gb` at install time and is
removed from every other path, with a test pinning that the serving path never
reads it.

### 2. Throughput, derived from the trace — `core/app/chat.py`

When an `llm_call` span closes with both `completion_tokens` and a duration, it
carries `tok_per_s`. Computed, never stored anywhere else; absent when either
input is absent, because a null is not a measurement.

`core/app/model_speed.py` reads those spans and answers two questions with no
new probe and no configuration:

- `recent(model, window)` — the median tokens/sec over that model's rounds in
  the window.
- `baseline(model)` — the median over a longer window, which IS "normal for
  this model on this machine". Derived from history, never a constant someone
  maintains: a model that has always been slow here has a slow baseline and is
  not reported as degraded.

Known limit, stated: this measures GENERATION. Prompt processing is not
separately recorded on the span, so a turn slowed only by a huge prompt is not
visible to this check.

### 3. The beat says it — `core/app/checks/inference.py`

A new check family, `inference_degraded`, on the S11 machinery. It fires when a
model's recent median is worse than its baseline by more than
`inference.degraded_factor` (a setting, default 5), and it puts BOTH numbers in
the finding: "qwen3.8:27b is generating at 0.3 tok/s; its usual here is 67".
It adds the live free VRAM to the facts when the gateway can be asked, because
the first question the owner will have is what took the card.

It declares `urgent=False` and rides every rail S11 already has: the
fingerprint is over the derived facts, a repeat folds, once-per-24h-per-
fingerprint, the Inbox item links to its trace.

A check is code that reads rows and returns findings, so this one reads spans
and the gateway's VRAM route, and writes nothing.

### 4. The harness stops wasting an hour — `core/app/evals/`

- **An ungradeable streak ends the run.** After each case, count trailing
  ungradeable rows; at `EVAL_UNGRADEABLE_STREAK` (3) close the run `error` with
  the reason and the last case's own words. Yesterday's run would have stopped
  after fifteen minutes instead of two hours, saying why.
- **A cancel route.** `POST /api/v1/evals/runs/{id}/cancel` marks the row
  cancelled and the job notices at its next case boundary. Today the only stop
  is restarting core, which I did twice.
- Both are STATEMENTS about a run that cannot produce a measurement, never a
  judgement about the model.

### 5. She can see it — `core/app/tools/inference.py`

`inference_health()`: the live free and total VRAM, each resident model and its
size, this model's recent tokens/sec against its baseline, and whether a suite
run is in flight. One read, no arguments, `reads_only=True`.

Per CLAUDE.md this is the part that makes the slice hers rather than mine: on
the 12th she could not see that the card was contended, could not say why her
turn had failed beyond quoting the timeout, and could not tell the owner what
to close. Registry 35 → 36.

## What refuses, states, or is deleted when the model is wrong

- The fit decision reads the card at the moment of the question. A file written
  at install time cannot answer it and is no longer asked.
- `free_vram_gb_for_switch` and `swappable` are deleted rather than repaired,
  so nothing can go on quietly returning total-VRAM-as-free.
- A degraded card is reported with BOTH numbers, so "slow" is never an
  adjective — it is 0.3 against 67.
- A baseline is the model's own history, so a slow model is not libelled and a
  fast one that collapses is caught.
- A suite run that cannot produce a measurement ends and says why, instead of
  spending an hour proving it.
- Nothing here refuses a turn or picks a different model. A check may state
  that a call cannot run; it may never decide that it may not.

## Out of scope, on purpose

- **Routing around a degraded card.** Falling back to a smaller model when the
  card is busy is a decision on his behalf, and S10's mode switch is where that
  conversation belongs if he ever wants it.
- **Configuring the runtime** (`OLLAMA_MAX_LOADED_MODELS`, KV-cache
  quantisation, a context cap, the Windows sysmem-fallback policy). The audit
  found every one of those unset, and each is a real choice with its own
  trade-off — a separate conversation, not a side effect of this one.
- **The 300 s gateway timeout.** It bounds silence and is doing its job; the
  problem was never that it fired.

## Definition of done (walked, by reproducing it)

The failure can be reproduced deliberately, which is the point of this slice:

1. With the card clear, ask her something and note the turn's `tok_per_s`.
2. Squeeze the card — load a second large model alongside the chat model, so
   free VRAM collapses and generation slows.
3. Ask again. The turn still answers, and `inference_health` reports the free
   VRAM, what is resident, and the collapsed rate against the baseline.
4. Fire the beat. An Inbox item names the model, both numbers, and the free
   VRAM, and it folds rather than repeating on the next beat.
5. Start a suite run against a model that cannot answer; it ends after three
   ungradeables with the reason, not after twenty-three.
6. Release the card and confirm the notice clears rather than standing.

---

## As built (2026-09-14)

Five parts, as specified. Four things moved during implementation, each
because building it made the spec's version untrue.

### The frame had to change, and that forced two more edits

The spec said "read free VRAM live" and stopped there. It could not stop
there. Ruling S2f-R3 had defined `needed_gb` as the WHOLE-CARD figure — the
number nvidia-smi's `used` counter shows while the model serves, desktop
baseline included — and that frame is exactly what forced `free_gb` to stay
the card's full capacity: subtracting the baseline from free too would have
counted it twice. "Free equals total, always" was a correct consequence of
a coherent frame, and a catastrophic property in practice.

So `fit.py`'s frame is rewritten and stated once: every number is the
MODEL'S own VRAM, and the baseline lives on the free side only, where the
driver has already subtracted it. Two consequences:

- **The probe records a different number.** It now reads ollama's own
  `/api/ps` `size_vram` for the model that just answered instead of an
  undirected nvidia-smi reading. That is not tidiness: on the 12th an
  undirected reading would have recorded 7 GB of the game's texture memory
  as the model's own footprint and stored it badged `verified`.
- **`curated_models.json`'s 27B estimate goes 22 → 18.** Both numbers
  describe the same 2026-08-29 measurement; they differ by the baseline,
  which moved sides. Left at 22 it would have read `wont_fit` on a card
  where the model demonstrably runs.

### Prompt processing is separated rather than disclaimed

The spec conceded a limit: "a turn slowed only by a huge prompt is not
visible to this check." Splitting the round at the first content delta
costs one variable and removes the limit instead — `ttft_ms` is prompt
processing, `generation_ms` is generation, and `tok_per_s` divides by the
second. A turn with an enormous prompt no longer reads as a degraded card.

### `cancelled` is its own status

The spec said the cancel route "marks the row cancelled" without saying
whether that was a new state. It is: reusing `interrupted` would have made
"the process died under it" and "somebody pressed Stop" the same fact, and
a reader of a half-finished run should not have to guess which happened.

### `needed_gb` gained a middle source, and one shared map

The spec's "prefer the catalogue's own `facts.size_bytes`" would have made
`/admin/suggest` and the catalogue disagree about the same model, because
only one of them had the bytes. `_fit_context` now carries ONE size map
(ollama's `/api/tags`, cached) that both read — the same reason it already
carried one card reading.

### Out of scope, still out

Routing around a degraded card, configuring the ollama runtime, and the
300 s gateway timeout. Unchanged from the spec.

### What is not done

The DoD walk. Every part is built and tested (450 gateway, 888 web, the
core suite), but nothing here has been walked against the live stack with a
second model squeezing the card. That is the next thing, and it is the only
thing that can say this works.
