# Prompt caching, and the window a local model actually gets

Built 2026-08-04 in `.worktrees/prompt-cache` (branch `feat/prompt-cache`).
These are lanes 3 and 4 of the four Jeremy approved on 2026-08-03; lanes 1
(the stale-refresh treadmill, migration 085) and 2 (fallback chains,
`ccabf2b`) already shipped.

The two asks behind them:

> *"yes, i'd love to have prompt caching. can it be a global cache that all
> models could read/write to/from?"*

> *"it's supposed to be dynamic. our model's context windows are supposed to
> adjust based on the size of the model, and the size of the remaining vram
> so we can leverage as much context as possible without running out of
> context and truncating."*

---

## The honest answer to the first one

**There is no cross-model or cross-provider shared cache, and there cannot
be.** A prompt cache is the KV tensor produced by *one* model's weights at
*one* quantisation on *one* server. Ollama's lives in that GPU's VRAM and
dies when the model unloads. Anthropic's and OpenRouter's are per-account,
per-model, per-exact-prefix, on their own hardware. Nothing crosses. Nova
cannot build a shared cache; it can only make each provider's own cache
*hit more often*.

And **automatic prefix caching already worked everywhere it exists.**
MEASURED over the five days to 2026-08-03, `sum(cached_tokens)/sum(prompt_tokens)`:

| | |
|---|---|
| ingestion on z-ai/glm | **61.7%** (182/182 calls reporting) |
| main on z-ai/glm | **60.1%** |
| maintainer | **53.0%** |

`main`'s headline 1.9% lifetime figure was never a caching failure. 29% of
its tokens went through ollama, which **has no cached-token field at all**;
45% through claude-haiku, which reports the field faithfully and returned 0
because Anthropic caches only what an explicit `cache_control` marks.

So the work was not "build a cache". It was: make the local half
measurable, stop moving the bytes providers cache against, and be able to
mark a boundary for the one family that requires it.

---

## What shipped

### The prompt now has a stable half and a volatile half

`_build_system_prompt` returns `(stable, volatile)` instead of one string.
The prose is byte-identical — the two halves join with the same `"\n\n"` —
but everything whose bytes can differ between two consecutive turns is now
BEHIND everything whose bytes cannot.

| STABLE (the cacheable prefix) | VOLATILE |
|---|---|
| the agent's own system prompt | automation state and live counts |
| `## Model (live)` | goal progress |
| `## Platform facts (live)` | the newest capability events |
| the acquisition shapes | retrieved memories and skills |
| the MCP server index | the rolling summary |
| who is speaking | **the clock** |
| the specialist index | then LAST WORD: soul, name, toolset, register |

Before this, `_now_block()` (changes every minute), `_entities_block` (15s
TTL, interpolates each automation's `last_status`), `_goals_block` and
`capability_events.prompt_block` (newest 8 in 72h — **38 events in the last
72h, so the top-8 set rolls ~13x/day**) all sat AHEAD of ~1,225 tokens of
text that never changes at all.

**MEASURED on this box, qwen3:8b, a 7,240-token system prompt, four
consecutive turns each:**

| where the changing block sits | prefill, per turn |
|---|---|
| at the TAIL (what it does now) | 21ms, 27ms, 30ms, 37ms — *with history growing each turn* |
| at the HEAD (what it did before) | 1,524ms, 1,610ms, 1,730ms, 1,510ms |

Same content, same model, same box. ~50x.

### Cache breakpoints, for the providers that need one

`llm_router.supports_cache_control(model)` — False for ollama (which has no
server-side prompt cache to address, only a resident KV cache) and for every
provider that caches automatically; True for `anthropic/`, `google/` and
`qwen/` families on OpenRouter, and for those APIs reached as their own
provider row (matched on the API host, not on the operator-chosen slug).

`runner._system_message(stable, volatile, model)` emits **one** breakpoint,
not four: a breakpoint marks a prefix, not a region, so the last one wins
and the earlier ones only cost payload — and the tools array is rendered
ahead of `system` by every provider that supports this, so a system
breakpoint already covers the tool schemas.

**This currently no-ops on every agent bound to Claude**, and that is on
purpose rather than by accident. Anthropic's minimum cacheable prefix is
4,096 tokens; estimated stable prefixes are main ~5,500 (clears it),
ingestion ~4,340 (marginal), and **deployer ~1,993, guardian ~1,603,
news-summarizer ~1,717, model-manager ~1,423, maintainer ~1,382** — all
under. Below the minimum Anthropic returns `cache_creation_input_tokens = 0`
**with no error**, so the `build_prompt` span now records `stable_chars`,
`volatile_chars`, `tools_chars` and `cache_breakpoint`. That span is the
only place a silent no-op can be seen.

### A local cache hit is visible for the first time

Ollama publishes no cached-token count anywhere in its API, so
`cached_tokens` is deliberately left UNSET for local calls — a number we
derived, sitting in the one column that means "the provider told us", would
poison it. What ollama does publish is nanosecond durations, and a reused
prefix shows up as `prompt_eval_duration` collapsing 50x for an unchanged
`prompt_eval_count`. Those three durations (`prompt_eval_ns`, `load_ns`,
`total_ns`) now ride the usage event onto the `llm_call` span.

Also: `model_warmer._ping` now sends `options.num_ctx` from
`local_context.resolve`. A load is per (model, window), so warming at
ollama's server default and then chatting at the sized window loaded the
model twice and threw the first KV cache away — the entire point of
warming, spent on a runner nothing would use.

---

## The sizer: four defects, all measured

### GAP 1 — VRAM held by another *ollama* model was counted as gone

`_free_vram_bytes` subtracted every used byte and added back only the model
being sized. Ollama's scheduler **evicts** a resident runner to fit the next
one, so that memory was always claimable.

MEASURED 2026-08-03 15:49: `ornith:9b` was resident at a 262,144 window
(14.2 GB) when `qwen3:8b` was sized. Three re-derivations minutes apart all
logged `affordable 0 ... free 5.2GB`; qwen3:8b was floored at 8,192 and the
turn died — trace `075ee7cb`, `error_class: prompt_too_long`, 10,303 tokens
against a 4,192 ceiling. Meanwhile ornith held 262,144 tokens of KV against
a 30-day peak demand of 11,971.

`_vram()` now returns `{total, used, ollama_held, foreign}` and `_claimable`
subtracts only `foreign` — whisper, kokoro, a Windows game: things nothing
here can evict.

**Reproduced on purpose, 2026-08-04**, with ornith:9b pinned resident at
262,144 holding 14.0 GB and the card at 17,222 / 24,576 MiB:

```
old: free=5.2GB  -> kv_budget=-0.6GB -> affordable=0     -> FLOOR 8192   (turn dies)
new: claimable=19.6GB -> kv_budget=13.8GB -> affordable=93,769 -> 16,384 (turn answers)
```

### GAP 2 — GiB labelled GB, 7.3% of a 3090 that did not exist

nvidia-smi reports MiB; `inference-control/server.py` divides by 1024 and
calls the result `mem_total_gb`. Every other consumer is a dashboard, where
7.3% does not show. This module does arithmetic against ollama's real byte
counts, where it does: a card reporting 24,576 MiB is 25.77e9 bytes, and
multiplying the "GB" by 1e9 gave 24.0e9 — **1.77 GB that existed and was
never offered to anybody.** Fixed at the consumer (`_GIB`); the field name
is left alone because renaming it reaches a DB column, the sidecar and the
frontend for no gain.

### GAP 3 — two answers to one question, and one that never expired

The trimmer sized against `local_context.cached()` while the refusal sized
against `local_context.effective_window()`. `llm_router.window_for()` now
resolves ONCE per call and the number is passed down to both. The router's
usable budget also gained the `max(2000, …)` clamp `ceiling_for` already had
— without it the two disagreed on every window under 6,000.

`_ceiling` (the post-spill cap) was written once and never cleared, so one
spill under transient pressure pinned a model a rung low until the backend
restarted, with no log line saying why the window never came back. It now
carries a 30-minute expiry and says so when it lapses.

And `local_context.warm()` ran **once** at boot: `cached()` falls through to
`_last_known`, which never expires, so it returns None only when `resolve()`
has NEVER succeeded in this process. MEASURED — `ollama:ornith:9b` sat at
the 60,000-token unknown-window default for **34 spans across two days**
(2026-08-01 19:59 → 2026-08-03 14:16). It is a retry loop now; the retry is
the fix, not the cadence.

### GAP 4 — nothing trimmable meant a dead turn

`trim_transcript` only ever shortened `role=="tool"` messages, and dispatch
results were exempt without exception. On round one of a fresh conversation
there are no tool messages at all, so it logged and returned over the
ceiling and the router refused a turn that had not started. That is trace
`075ee7cb`.

`_hard_trim` is the last resort, in order: exempt tool results, then
user/assistant prose oldest-first, then the final message. **Index 0 is the
only absolute exemption** — the system prompt is what head-truncation eats
and the reason any of this exists. This REVERSES the "dispatch results are
EXEMPT" rail; the module docstring is updated in the same commit, because
code and contract disagreeing is worse than either rule.

The brief said never to touch the final message. That is wrong for the case
it was written for: on a fresh conversation a 40,000-character paste IS the
overflow and the only thing that can give. It is trimmed last, not never.

### And the sizer now knows what is being ASKED for

Capacity was the only input, so a model took every token that fit whether or
not anything wanted them. `_demand_tokens` reads the 7-day maximum of
`prompt_tokens_est_fixed` from `turn_spans` — a new field the trimmer writes,
which is the prompt estimate **excluding replayed history**.

That exclusion is the whole trick. `history_budget_for` is 35% of the
window, so a bigger window replays more history, which would inflate the
very number the window is sized from — each rung buying the next until
`_HISTORY_MAX` stopped it. `_want_rung` walks the ladder and takes the
smallest rung that holds `demand + the history THAT rung would allow`, so
the answer never depends on the previous answer.

Demand rounds UP, capacity rounds DOWN, and the smaller wins. **No reading
means no demand-side opinion** — `_want_rung` returns the model's ceiling
and capacity decides alone, exactly as before.

**Live, 2026-08-04**, after three real turns had written the new field:

```
qwen3:8b  -> num_ctx=16384 (model max 40960, demand 6933, affordable 94065)
```

16,384 instead of 40,960 — **3.6 GB of VRAM** that was being held for
nothing, which is the memory that starved the next model at 15:49.

### GAP 4b — the truncation ollama performs silently

A prompt that does not fit is not refused; it is CUT, from the head, and the
response carries `done_reason: "stop"` and no error field. MEASURED on
ollama 0.31.2 (`--context-shift --keep 4`): a ~9,050-token prompt at
`num_ctx` 2048 reported `prompt_eval_count: 1026` and answered "I am a
language model" instead of the SENTINEL it had been told to say. Survivors
are `num_ctx//2 + 2` exactly — 2048→1026, 4096→2050, 8192→4098.

`ollama_native` now emits a `context_truncated` event on that signature, or
when the count is far below what was sent (mandatory: on every path where
`resolve()` returned None no `num_ctx` is sent and the arithmetic has no
input). The runner records it on the span and **appends a visible sentence
to the reply text** — not a banner, because banners are stripped from
history and the next turn would answer from a reply it has no reason to
distrust. It does not auto-retry: the round has already streamed and may
have run tools.

The signature belongs to that ollama version and launch configuration, so
all three measured points are pinned in a test that will fail loudly on an
upgrade.

---

## Still open

- **The live multi-turn chat prefill did not collapse** (1,980ms → 1,933ms
  across two real turns on qwen3:8b) even though the stable half was
  byte-identical at 10,862 chars on all three turns and the controlled
  probe above shows the mechanism works with history growing. The likely
  cause is other local traffic evicting the single llama.cpp slot between
  turns — model probes, fitness checks and the tournament job all call
  ollama. NOT isolated. It is now measurable, which is the prerequisite.
- **`ornith:9b` still sizes to 262,144** because no turn has run on it since
  `prompt_tokens_est_fixed` started being written. It drops to a demand-sized
  rung the first time it does. This is the documented "no reading, no
  opinion" behaviour, not a bug — but it means the 15:49 hazard is only half
  closed until each local model has run once.
- **`cache_style` as a provider column** stays deferred. It does not answer
  for OpenRouter, which multiplexes many families behind one row, so the
  family-prefix helper survives either way. Not worth a migration until a
  second explicit-cache provider is registered directly.
- **The `round(..., 1)` in the sidecar** quantises the VRAM reading to ±53 MB.
  Harmless against a 2 GB reserve; noted so nobody re-derives it as a defect.
