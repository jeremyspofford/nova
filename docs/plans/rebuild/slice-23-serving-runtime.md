# Slice 23 — the serving runtime is chosen, and visible

Branch `slice/s23` in `.worktrees/s23`, cut from `rebuild/v4` at 4af2ad8a.

## First, a correction

I recommended this slice as "the cheapest fix for a card that's routinely
6 GB down", and I recommended it without measuring. Before writing a line
of it I read what the runtime is actually doing, and two of the four knobs
I named are not what I said they were.

**Flash attention is already on.** `OLLAMA_FLASH_ATTENTION` reads `false`
in the server config — which is what I would have "fixed" — but
llama-server is launched with `--flash-attn auto` and the log says
`resolve_fused_ops: Flash Attention enabled`. Setting the env var changes
nothing. Stated here so nobody spends a slice turning on something that is
on.

**The KV cache is smaller than I implied.** At 32k it is 2,048 MiB, not the
"several GB" my recommendation leaned on.

The recommendation survives anyway, for a reason I can now state precisely
rather than assert — see the margin below. But it is a narrower slice than
I sold, and the measurements belong in the record.

## What is actually running (measured 2026-09-14)

`deploy/docker-compose.yml` gives the ollama service **no environment block
at all**, so every knob is at its default:

    OLLAMA_CONTEXT_LENGTH: 0       (unset — ollama serves 32768)
    OLLAMA_KV_CACHE_TYPE:  ""      (unset — f16)
    OLLAMA_MAX_LOADED_MODELS: 0    (auto — 3 per GPU)
    OLLAMA_NUM_PARALLEL:   1
    OLLAMA_KEEP_ALIVE:     5m0s
    OLLAMA_FLASH_ATTENTION: false  (and yet: enabled, see above)

`qwen3.8:27b`, from ollama's own load lines:

    load_tensors: offloaded 66/66 layers to GPU
    load_tensors:  CUDA0 model buffer size = 15339.44 MiB
    load_tensors:  CPU_Mapped model buffer size = 682.03 MiB
    llama_kv_cache: size = 2048.00 MiB (32768 cells, K f16 1024 / V f16 1024)
    llama_context: n_ctx = 32768

So: ~15.3 GB of weights on the card, 2.0 GB of KV, and 0.7 GB of embeddings
deliberately left on the CPU. **A GPU footprint of about 17.4 GB**, which
matches the 16,594 MiB `/api/ps` reports for it.

### The margin, which is the whole point

    card total                     24.0 GB
    held by the game + desktop      6.4 GB   (measured, twice, on 09-14)
    free                           17.7 GB
    the 27B needs                  17.4 GB
    -----------------------------------------
    headroom                        0.3 GB

That is the wedge. It is not "slow because the GPU is busy" — it is a model
that technically fits with nothing left for the compute buffers a
generation needs, so it thrashes and produces no tokens at all. It explains
why the 12th degraded to 0.25 tok/s and the 14th produced nothing: the same
squeeze, slightly harder.

**Every gigabyte is decisive at a 0.3 GB margin**, which is why a 2 GB KV
cache is worth attention even though it is small in absolute terms.

### Nobody chose 32768

The model declares `qwen35.context_length = 262144`. It is served at 32768
because that is ollama 0.33's built-in default with `OLLAMA_CONTEXT_LENGTH`
unset. Not the model's number, not ours. The single most expensive runtime
property on this host is a default nobody looked at.

## The decisions (yours)

Four, with the measured cost of each. I have a recommendation for all four
and none of them is mine to make.

### 1. Context length — how much she can hold, against headroom

KV scales linearly with context, so on this model:

    32768 (today)  2048 MiB KV
    16384          1024 MiB KV     saves 1.0 GB
     8192           512 MiB KV     saves 1.5 GB

**Recommendation: 16384.** It buys a gigabyte against a 0.3 GB margin, and
a turn that genuinely needs more than 16k tokens of conversation, recalled
memory and tool output is rare enough that I would rather find out from a
real one than pay for it on every turn. 8k I would not: skill bodies, a
long file read and a memory recall can plausibly reach it, and being
truncated mid-work is a worse failure than being slow.

Against it: it is a real capability reduction, and it is the knob you are
most likely to regret. If you would rather not lose context, take the KV
type below instead — it buys the same gigabyte without touching what she
can hold.

### 2. KV cache type — precision, against the same gigabyte

    f16 (today)   2048 MiB
    q8_0          1024 MiB     saves 1.0 GB
    q4_0           512 MiB     saves 1.5 GB

**Recommendation: q8_0.** Eight-bit KV is widely treated as near-lossless
and it costs nothing you can hold. q4_0 I would not take without measuring
it against the corpus — it is exactly the kind of change that degrades long
answers subtly and shows up as "she got worse" three weeks later with no
way to attribute it.

**Taken together, 16k + q8_0 leaves 512 MiB of KV: a 15.9 GB footprint and
1.8 GB of headroom instead of 0.3.** That is the difference between wedging
and working while you game.

### 3. `OLLAMA_MAX_LOADED_MODELS` — the failure nobody has hit yet

Unset means auto, which is three models per GPU. On a 24 GB card holding a
17 GB model, a second resident model is not a degradation, it is an
out-of-memory. Nothing has triggered it because chat and beats use the same
model today — but an agent with its own model, or a suite run against a
different one, would.

**Recommendation: 1.** Free, and it removes a failure mode that would
otherwise be discovered the hard way.

### 4. `OLLAMA_KEEP_ALIVE` — leave it, and know why

Five minutes means the model unloads while idle and pays a cold load on the
next turn. That is why S21's warm-up exists. Raising it would hold 17 GB of
your card hostage through an evening of gaming, which is the opposite of
what this slice is for.

**Recommendation: leave at 5m**, and write down that it is deliberate.

### Explicitly NOT here

- **The Windows sysmem-fallback policy.** It is an NVIDIA driver setting on
  the Windows side, not an ollama knob and not in this repo. When VRAM runs
  out the driver silently spills to host RAM, which is the mechanism behind
  "it still answers, 270x slower". Worth changing, and it is a thing you do
  in the NVIDIA control panel, not something Nova can own.
- **Picking a smaller model when the card is busy.** Still S10's mode
  switch, still a decision on your behalf, still not this slice.

## What gets built

### A. The knobs, declared and pinned

An `environment` block on the ollama service carrying every value above —
including the ones left at their defaults, written out explicitly. An unset
knob is indistinguishable from a knob nobody knew about; a declared one that
happens to equal the default is a decision with a name.

`tests/test_serving_runtime.py` (gateway) reads the compose file and pins
the set, so adding a knob is deliberate and removing one reddens.

### B. The runtime, visible

Nothing in the product can see any of this today. The context it is serving
at, what the KV costs, whether all the layers made it onto the card — every
number in this document came from `docker logs`, which is exactly the shape
of gap S22 closed for free VRAM. When it wedges again the first question is
"what is it serving at", and the product has no answer.

- `GET /admin/vram` gains a `runtime` block: the serving context length, the
  KV cache type, and the per-model KV cost where ollama states it.
- `inference_health` says it in words, so she can answer the question.

Source of truth to be confirmed during implementation: ollama's `/api/ps`
entry carries `context_length` in recent versions (its shape could not be
read on 09-14 — nothing was resident at the time). If it does not, the
fallback is the declared env plus `/api/show`, and the honest answer when
neither states it is that it is unknown, never a guess.

### C. A measurement, not a belief

The whole slice is an argument about gigabytes. Before and after, with the
card in a known state:

1. Load the 27B, read `/api/ps` `size_vram` and ollama's `llama_kv_cache`
   line. That is the before, and it is already recorded above.
2. Apply the chosen knobs, restart ollama, load again, read both again.
3. The delta must be the predicted one. If 16k + q8_0 does not land near
   15.9 GB, one of the numbers in this document is wrong and I would rather
   find out here than believe it for a month.

## Definition of done

- The knobs are declared in compose and the tripwire pins them.
- The measured footprint moved by the predicted amount (part C), recorded.
- `inference_health` reports the serving context and KV type, and she can
  answer "what is it serving at" without anyone reading a container log.
- A turn runs to completion while the game is holding ~6 GB — the failure
  of 2026-09-14, repeated and survived. This is the one that matters, and
  it needs the card in that state, so it waits for a real evening.

## What would make this slice wrong

If the 27B is simply too big for a machine that games, no arrangement of
knobs fixes that, and 1.8 GB of headroom is still thin. The honest
alternative is a smaller model or a smaller quant of this one, and that is
a conversation about what Nova is for rather than about ollama's
environment. This slice is worth doing either way — the runtime should be
chosen and visible regardless — but it should not be mistaken for a
guarantee.
