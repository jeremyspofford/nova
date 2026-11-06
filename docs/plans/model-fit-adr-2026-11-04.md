# Model fit and recommendations per device (ADR, step 1, 2026-11-04)

**Sources:** the owner's direction, `docs/builder-packet/nova-device-model-fit-and-roles-2026-11-04.md`
(binding). Device roles: `docs/plans/M10-orchestration.md` Point 9 and `docs/plans/M10f.md` §1.
The model manager: `docs/plans/M6.md` §2 and `src/core/models/` (`hardware.ts`, `recommend.ts`,
`ollama.ts`, `wake.ts`, `index.ts`). The Models settings screen: `ui/js/models.js`. The eval
scorecards: `src/core/evals/scorecards.ts`. Privacy modes: `src/core/envelope.ts`.

**Status:** this is the design. Nothing is built in this step. Step 2 (inventory reporting and the
fit engine, test-first) starts from the contract and the golden cases below. Each golden case is
written to become one test.

**Units:** "GB" here means GiB (2^30 bytes), as `hardware.ts gb()` prints it. nvidia-smi reports
MiB, so a 24 GB card is 24,576 MiB, which is 24 GiB.

## Decision

1. **Nova decides whether a model fits a device with deterministic code, never an LLM's guess.**
   The fit engine is a pure function: memory needed = weights + KV cache + runtime overhead + a
   safety reserve, compared with the device's memory budget. Every verdict says which quant and
   context it assumed.
2. **The inventory extends what Nova already collects.** The device agent already reports GPUs,
   VRAM, the unified-memory flag, RAM, CPU, arch, disk and network cards (`hardware.ts`). The hub
   already stores them (`device_hardware`), the installed models (`model_version`) and wake times
   (`device_wake`). Step 2 adds only what fit needs: what the backend has loaded and how much
   memory it reports using, each model's architecture, a per-device learned overhead, and the wake
   policy.
3. **The overhead is learned per device from real loads, within bounds.** The safety reserve is
   never learned.
4. **Recommendations are per task class, and privacy filters first.** Under local-only, cloud
   candidates are removed before anything is ranked.
5. **A static memory-band tier table exists only as a labelled fallback** for a model whose
   architecture Nova can't read or look up.
6. **Device roles are not redesigned here.** They are as M10 decided: multi-select roles
   (`purposes` in code, "Roles" on screen), with hub candidate as its own tier-3 flag, confirmed on
   the hub's approval screen (`src/core/mesh/purposes.ts`). The one new tie-in is that the compute
   role, or a GPU Nova finds, is what surfaces the model-fit step in device setup (step 3).

## The device inventory schema

The record the fit engine reads, per device. "Today" names where the value already comes from;
**New** marks what step 2 adds. The hub's own hardware is read when asked, not stored (as today);
a paired computer's comes in its heartbeat.

| Field | Type | Today | Status |
|---|---|---|---|
| `hardware.at` | ISO time | `detectHardware`, read at boot and then hourly (`device/boot.ts`) | Exists |
| `hardware.platform`, `hardware.arch` | string | Node's `os` | Exists |
| `hardware.cpu.model`, `.threads` | string, number | Node's `os.cpus()` | Exists |
| `hardware.ram_bytes` | bytes | `os.totalmem()` | Exists |
| `hardware.ram_free_bytes` | bytes | `/proc/meminfo` MemAvailable on Linux, `os.freemem()` elsewhere | Exists |
| `hardware.gpus[]` `.vendor`, `.name` | enum, string | nvidia-smi, rocm-smi, system_profiler | Exists |
| `hardware.gpus[].vram_bytes` | bytes | the same tools. For Apple silicon, 0.75 × RAM is written here today (see "Unified memory" below) | Exists; the Apple rule changes |
| `hardware.gpus[].vram_free_bytes` | bytes or null | nvidia-smi and rocm-smi; null on Apple | Exists |
| `hardware.gpus[].unified` | boolean | true for Apple silicon | Exists |
| `hardware.disk.free_bytes` | bytes | `statfs` on the agent's folder | Exists |
| `hardware.network[]` `.mac`, `.broadcast` | strings | Node's `os.networkInterfaces()`, private addresses only (`checkHardware`) | Exists |
| `hardware.sources` | string list | which tool read each part | Exists |
| `inventory.updated_at` | ISO time | `device_hardware.updated_at` | Exists. The screen shows it as an age while the device sleeps |
| `purposes` | role list | the device record (`0020_device_purposes.sql`), from pairing | Exists (M10f) |
| `capabilities` | string list | the device record, from enrollment claims (`mesh/enroll.ts`) | Exists |
| `backend.kind`, `.url`, `.version` | `'ollama'`, URL, string | `Ollama.version()`, `ModelManager.inventory()` | Exists |
| `backend.installed[]` | name, digest, size, params, quant, family | `Ollama.tags()` into `model_version` (kept while asleep, with `last_seen`) | Exists |
| `backend.loaded[]` `.name`, `.size_bytes`, `.vram_bytes`, `.context`, `.expires_at` | per loaded model | `Ollama.ps()` today returns names only | **New:** keep the `size`, `size_vram`, `context_length` and `expires_at` that `/api/ps` reports |
| `backend.split_across_gpus` | boolean | — | **New.** False until verified for a backend, so the budget stays per GPU |
| `backend.kv_type` | `'f16'`, `'q8_0'` or `'q4_0'` | — | **New.** f16 unless the backend reports otherwise |
| `model.arch` `.layers`, `.kv_heads`, `.head_dim`, `.max_context` | numbers | `Ollama.show()` reads `capabilities` and `details` only | **New:** read `model_info` (`<arch>.block_count`, `.attention.head_count_kv`, `.attention.key_length` or `embedding_length ÷ head_count`, `.context_length`) |
| `unified_budget_bytes` | bytes | — | **New:** the rule below, on unified devices only |
| `learned_overhead` `.bytes`, `.n`, `.last_observed`, `.updated_at` | per device and backend | — | **New:** a table, `device_overhead` |
| `wake.capable` | boolean | derived: a network card is reported (`ModelManager` device view) | Exists |
| `wake.latency_ms` | number or null | `device_wake`, the last answered wake | Exists |
| `wake.on_demand`, `wake.sleep_after_min` | boolean, number or null | — | **New** (step 4): per-device policy, never sleep or sleep after N idle minutes |
| `state` | `'awake'`, `'asleep'` or `'unknown'` | derived: Online is a heartbeat within 2 minutes | Exists as Online. "Asleep, wakeable" is new wording in step 4 |

**The budget the engine uses, per device:**

| Device | Budget | Why |
|---|---|---|
| Discrete GPU | that GPU's `vram_bytes`, the largest GPU, unless `split_across_gpus` is true | A model that isn't split must sit on one card |
| Several GPUs, with the backend splitting | the sum of their `vram_bytes`, with overhead counted per GPU | Only when the backend really splits a model |
| Unified memory (Apple silicon) | 2/3 of RAM below 36 GB of RAM, 3/4 at 36 GB and above | macOS's default GPU working-set limit (an assumption; see below) |
| No usable GPU | 0.5 × RAM, as `modelMemory()` does today, and every verdict says "on the CPU, slow" | Unchanged |

`other_use_bytes` is what else holds the GPU: `vram_bytes − vram_free_bytes − (memory the backend
reports for its loaded models)`, never below 0. It is a bar segment of its own and is subtracted
from the budget. It is 0 when free VRAM is unknown, and the verdict then says so.

**Unified memory, a finding.** `hardware.ts` writes 0.75 × RAM as an Apple GPU's memory. macOS's
default limit is reported to be about 2/3 of RAM on machines with less than 36 GB, and 3/4 above.
That difference changes verdicts: a 14B model at Q4_K_M and 4k context is Tight on a 16 GB Mac at
0.75, and Won't fit at 2/3. This ADR takes 2/3 below 36 GB as the conservative default. Step 2 must
verify it on a real Mac (llama.cpp's Metal backend logs `recommendedMaxWorkingSetSize` at load), and
the learned overhead corrects what remains. Nova never raises the limit itself. That is a system
setting, and the owner changes it if they want to.

## The fit-engine contract

A pure function in `src/core/models/fit.ts` (step 2). It reads no files and makes no network calls.
The same input always gives the same output, in integer bytes.

```ts
type Quant = 'Q4_K_M' | 'Q5_K_M' | 'Q6_K' | 'Q8_0' | 'F16';
type KvType = 'f16' | 'q8_0' | 'q4_0';
type Verdict = 'fits' | 'tight' | 'wont-fit';

interface FitDevice {
  memory: 'gpu' | 'unified' | 'cpu';
  budget_bytes: number;          // the budget table above
  other_use_bytes: number;       // 0 when unknown (other_use_known: false)
  other_use_known: boolean;
  overhead_bytes: number;        // learned_overhead.bytes, or the prior
  overhead_source: 'prior' | 'learned';
}

interface FitModel {
  name: string;
  params: number;                // parameter count, e.g. 8_200_000_000
  weights_bytes: number | null;  // the file's size when installed; null when only planned
  quant: Quant;
  context: number;               // tokens Nova will request (num_ctx)
  arch: { layers: number; kv_heads: number; head_dim: number } | null;
  arch_source: 'backend' | 'catalog' | null;
  kv_type: KvType;
}

interface FitInput { device: FitDevice; models: FitModel[] }   // one model in step 2; several in step 3

interface FitPart { name: string; weights_bytes: number; kv_bytes: number }

interface FitResult {
  verdict: Verdict;
  basis: 'formula' | 'tier-table';           // tier-table when any model's arch is null
  assumed: { quant: Quant; context: number; kv_type: KvType }[];   // one per model, always shown
  parts: FitPart[];
  overhead_bytes: number;                    // counted once per device (per GPU when split)
  reserve_bytes: number;
  other_use_bytes: number;
  need_bytes: number;                        // sum of parts + overhead + reserve + other use
  budget_bytes: number;
  headroom_bytes: number;                    // budget − need; negative when it won't fit
  max_context_fits: number | null;           // single model: the largest context, in steps of 1,024, that still fits
  words: string;                             // e.g. "Fits comfortably at Q4_K_M with 4k context."
}
```

**The arithmetic:**

| Term | Formula | Default |
|---|---|---|
| Weights | `weights_bytes` when installed (exact); otherwise `ceil(params × bits_per_weight ÷ 8)` | Effective bits per weight: Q4_K_M 5.0, Q5_K_M 5.7, Q6_K 6.6, Q8_0 8.5, F16 16. These include the higher-precision embedding and output tensors. Q4_K_M at 5.0 matches the catalog's Ollama download sizes within 3% (`recommend.ts CATALOG`) |
| KV cache | `layers × context × kv_heads × head_dim × 2 × bytes_per_element` (the 2 is K and V) | f16 = 2 bytes; q8_0 = 1; q4_0 = 0.5 |
| Runtime overhead | `learned_overhead.bytes` for this device and backend, or the prior | Prior: 1.0 GB (the CUDA or Metal context and compute buffers) |
| Safety reserve | `max(0.5 GB, 5% of budget)` | Never learned |
| Other use | `other_use_bytes` | 0 when unknown, and said |
| Need | weights + KV + overhead + reserve + other use | — |

**The verdicts:**

| Verdict | Rule | On screen |
|---|---|---|
| Fits | need ≤ 90% of budget | "Fits comfortably at Q4_K_M with 4k context." |
| Tight | 90% of budget < need ≤ budget | "Fits, but tight, at Q4_K_M with 4k context: nothing else can stay loaded." |
| Won't fit | need > budget | "Won't fit at Q8_0 with 16k context. At Q4_K_M it fits up to 6k." |

**Combinations (step 3):** the parts are summed, overhead and reserve are counted once per device,
and the verdict is for the whole set. Without a backend that splits, each model is placed on one GPU
and the binding constraint is per GPU.

**The context Nova requests must be the context it assumed.** `Ollama.chat()` sends no `num_ctx`
today, so Ollama uses its own default and the label could be wrong. Step 2 sends
`options.num_ctx` equal to the context in the plan, so the verdict describes what actually runs.

**Where the architecture comes from, in order:**

1. The backend's model metadata (`/api/show` `model_info`), for an installed model.
2. Nova's curated catalog (`recommend.ts CATALOG`, extended with `layers`, `kv_heads` and `head_dim`),
   for a model that is only planned. Each entry cites its model card.
3. Neither: `basis: 'tier-table'`. The verdict is labelled "Estimate: Nova doesn't know this model's
   shape".

**The fallback tier table.** It is used only when the architecture is unknown. It states the
largest model class to expect at Q4_K_M and 4k context, by budget band. Unified devices map RAM to
their budget first, so one table serves both kinds. Its entries are derived from the formula above
with the assumed architectures, so the table is never more generous than the engine for a catalog
model (a test checks this).

| Budget band (GB) | Expect at Q4_K_M, 4k | Example |
|---|---|---|
| under 6 | up to about 3B | — |
| 6 | about 4B | — |
| 8 | about 8B | an 8 GB card; a 16 GB Mac (budget 10.7) |
| 12 | 8B at Q8_0, or 14B (tight) | — |
| 16 | about 14B | a 32 GB Mac (budget 21.3) |
| 24 | 32B (tight), or 14B at Q8_0 | a 24 GB card |
| 32 | about 32B | — |
| 48 and above | 32B at Q8_0 | — |

The band is the largest one at or below the budget.

**The learned overhead.** After a real load, Nova compares its estimate with what the backend
reports, and corrects the device's overhead.

| Step | Rule |
|---|---|
| When | After a load Nova asked for, read from `/api/ps` on that device |
| Use only | a model fully on the GPU (`size_vram == size`); a partial load says nothing about overhead |
| Observation | `observed = size − weights_bytes(file) − kv_bytes(context_length that /api/ps reports, or the num_ctx Nova sent)` |
| Discard | an observation outside 0.25–4 GB. It means the weights or KV estimate is wrong (for example a quantized KV cache Nova didn't know of). It is logged, not learned |
| Update | `learned = learned + 0.3 × (observed − learned)`, starting from the prior of 1.0 GB |
| Bound | the learned value stays within 0.25–4 GB |
| Kept | per device and backend kind, in `device_overhead` (migration 0025), with the count, the last observation and the time. **Changed in step 2b, by the owner's direction:** it replicates to the standby, so a hub that takes over plans with what was measured. The hub's own row is keyed by its device id, not "hub", so a new hub doesn't take the old hub's figure for its own GPU |
| Shown | "Overhead: 1.1 GB, measured from 3 loads" or "Overhead: 1.0 GB, Nova's estimate" |

## Recommendations per task class

Each class gets a pick for this device and a smaller, faster alternative, each with its verdict.

| Task class | Today's role (`recommend.ts`) | Default context | Candidates |
|---|---|---|---|
| General chat | `reasoner` | 4k | text models, not coder-named |
| Coding | — (**New**) | 16k | text models; coder-named ones first |
| Screening and decisions (Tev1-class) | `triage-text` | 4k | small text models, at most 9B, on the hub (unchanged) |
| Embeddings | `embedder` | the model's own | embedding models |
| Vision | — (**New**) | 4k | models with the `vision` capability. The projector's weights come from metadata; without it, tier-table |
| Transcription | `transcriber` | — | unchanged: off until Nova has a whisper adapter |

**The order of filters and ranking:**

1. **Privacy first.** Local-only removes every cloud candidate and every Ollama model that runs
   remotely (`runsRemotely`) before ranking, so no cloud option is ranked or mentioned.
   Local-preferred ranks local candidates, and shows cloud only after them. Cloud-allowed can show
   cloud beside local. Cloud candidates have no fit verdict; they are labelled "runs off your
   devices".
2. **Task-class filter**, from the table.
3. **Fit**, at the class's default context and Q4_K_M, then Q8_0. Won't fit is removed.
4. **Rank:** larger parameter class first; within a class, Fits before Tight, then the higher quant.
   A current eval scorecard (`scorecards.ts`) breaks ties within a class. It never lifts a model that
   won't fit.
5. **Pick** = the first. Tight may be the pick only when it would be the only model planned on that
   device; step 3's combinations check it again.
6. **Alternative** = the best candidate of a smaller class whose verdict is Fits, or none.
7. **Nothing local fits:** say so, with the largest context that would fit (`max_context_fits`).
   Under local-only the work waits, as it does today. Otherwise a cloud option may follow.

## Golden cases

Each case becomes a test of `fit.ts` and of the ranking above, with integer bytes.

**Assumed architecture figures.** These are taken from the Qwen3 model cards as remembered, and
must be checked against the model cards before the tests are written:

| Model class | Parameters | Layers | KV heads | Head dim | KV per token (f16) |
|---|---|---|---|---|---|
| 8B (`qwen3:8b`) | 8.2B | 36 | 8 | 128 | 144 KiB |
| 14B (`qwen3:14b`) | 14.8B | 40 | 8 | 128 | 160 KiB |
| 32B (`qwen3:32b`) | 32.8B | 64 | 8 | 128 | 256 KiB |

KV per token = layers × 8 × 128 × 2 × 2 bytes. So the KV cache at 4k (4,096 tokens) and 16k (16,384)
is: 8B 0.56 and 2.25 GB; 14B 0.63 and 2.50 GB; 32B 1.00 and 4.00 GB.

**Weights** (planned, not installed, so from bits per weight): 8B 4.77 GB at Q4_K_M and 8.11 GB at
Q8_0; 14B 8.61 and 14.65 GB; 32B 19.09 and 32.46 GB. For example, 8.2 × 10^9 × 5.0 ÷ 8 =
5.125 × 10^9 bytes = 4.77 GB.

**The common assumptions:** overhead is the 1.0 GB prior (nothing learned yet); KV cache is f16;
other use is 0 (a headless device; the test sets it explicitly); privacy is local-only, and the
input includes one cloud candidate that must not appear in any output.

### Case 1: a 24 GB RTX 3090

Budget 24.00 GB. Reserve max(0.5, 1.20) = 1.20 GB. Fits up to 21.60 GB.

| Model | Quant | Context | Weights | KV | Overhead | Reserve | Need | Headroom | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 8B | Q8_0 | 16k | 8.11 | 2.25 | 1.00 | 1.20 | 12.56 | 11.44 | Fits |
| 14B | Q8_0 | 4k | 14.65 | 0.63 | 1.00 | 1.20 | 17.47 | 6.53 | Fits |
| 14B | Q8_0 | 16k | 14.65 | 2.50 | 1.00 | 1.20 | 19.35 | 4.65 | Fits |
| 32B | Q4_K_M | 4k | 19.09 | 1.00 | 1.00 | 1.20 | 22.29 | 1.71 | Tight |
| 32B | Q4_K_M | 16k | 19.09 | 4.00 | 1.00 | 1.20 | 25.29 | −1.29 | Won't fit |
| 32B | Q8_0 | 4k | 32.46 | 1.00 | 1.00 | 1.20 | 35.66 | −11.66 | Won't fit |

**Expected recommendations:**
- General chat (4k): pick **32B at Q4_K_M, 4k, Tight**. The alternative is 14B at Q8_0, 4k, Fits.
- Coding (16k): pick **14B at Q8_0, 16k, Fits**, because 32B won't fit at 16k. The alternative is 8B
  at Q8_0, 16k, Fits.

### Case 2: an 8 GB card

Budget 8.00 GB. Reserve max(0.5, 0.40) = 0.50 GB. Fits up to 7.20 GB.

| Model | Quant | Context | Weights | KV | Overhead | Reserve | Need | Headroom | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 8B | Q4_K_M | 4k | 4.77 | 0.56 | 1.00 | 0.50 | 6.84 | 1.16 | Fits |
| 8B | Q4_K_M | 16k | 4.77 | 2.25 | 1.00 | 0.50 | 8.52 | −0.52 | Won't fit |
| 8B | Q8_0 | 4k | 8.11 | 0.56 | 1.00 | 0.50 | 10.18 | −2.18 | Won't fit |
| 14B | Q4_K_M | 4k | 8.61 | 0.63 | 1.00 | 0.50 | 10.74 | −2.74 | Won't fit |

**Expected recommendations:**
- General chat (4k): pick **8B at Q4_K_M, 4k, Fits**. There is no alternative in this set.
- Coding (16k): **no local pick at 16k.** The answer says that 8B at Q4_K_M fits up to **6k**
  context: (7.20 GB − 4.77 − 1.00 − 0.50) = 995,328,396 bytes ÷ 147,456 bytes per token =
  6,750 tokens, rounded down to 6,144. Under local-only, no cloud option is mentioned.

### Case 3: a 16 GB unified-memory Mac

Budget 2/3 × 16 = 10.67 GB. Reserve max(0.5, 0.53) = 0.53 GB. Fits up to 9.60 GB.

| Model | Quant | Context | Weights | KV | Overhead | Reserve | Need | Headroom | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 8B | Q4_K_M | 4k | 4.77 | 0.56 | 1.00 | 0.53 | 6.87 | 3.80 | Fits |
| 8B | Q4_K_M | 16k | 4.77 | 2.25 | 1.00 | 0.53 | 8.56 | 2.11 | Fits |
| 8B | Q8_0 | 4k | 8.11 | 0.56 | 1.00 | 0.53 | 10.21 | 0.46 | Tight |
| 14B | Q4_K_M | 4k | 8.61 | 0.63 | 1.00 | 0.53 | 10.77 | −0.11 | Won't fit |

**Expected recommendations:**
- General chat (4k): pick **8B at Q4_K_M, 4k, Fits** (Fits is ranked before Tight within the
  class, so not 8B at Q8_0). No alternative in this set.
- Coding (16k): pick **8B at Q4_K_M, 16k, Fits**. No alternative.
- With the current 0.75 rule (budget 12.00 GB), 14B at Q4_K_M, 4k would be Tight instead of Won't
  fit. This case pins the budget rule.

### Case 4: a 32 GB unified-memory Mac

Budget 2/3 × 32 = 21.33 GB. Reserve max(0.5, 1.07) = 1.07 GB. Fits up to 19.20 GB.

| Model | Quant | Context | Weights | KV | Overhead | Reserve | Need | Headroom | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 8B | Q8_0 | 16k | 8.11 | 2.25 | 1.00 | 1.07 | 12.43 | 8.90 | Fits |
| 14B | Q4_K_M | 16k | 8.61 | 2.50 | 1.00 | 1.07 | 13.18 | 8.15 | Fits |
| 14B | Q8_0 | 4k | 14.65 | 0.63 | 1.00 | 1.07 | 17.34 | 4.00 | Fits |
| 14B | Q8_0 | 16k | 14.65 | 2.50 | 1.00 | 1.07 | 19.21 | 2.12 | Tight |
| 32B | Q4_K_M | 4k | 19.09 | 1.00 | 1.00 | 1.07 | 22.16 | −0.83 | Won't fit |

**Expected recommendations:**
- General chat (4k): pick **14B at Q8_0, 4k, Fits**. The alternative is 8B at Q8_0, 4k, Fits.
- Coding (16k): pick **14B at Q4_K_M, 16k, Fits**, because 14B at Q8_0 at 16k is Tight. The
  alternative is 8B at Q8_0, 16k, Fits.
- 14B at Q8_0, 16k is a boundary case: 19.21 GB against a Fits limit of 19.20 GB. The test asserts
  it in integer bytes.

### Case 5: the learned overhead (3090)

`qwen3:14b` at Q4_K_M is installed (a 9.30 × 10^9-byte file, 8.66 GB) and loaded at 4k.
`/api/ps` reports `size` = `size_vram` = 10.70 GB and `context_length` 4,096. Observed overhead =
10.70 − 8.66 − 0.63 = 1.41 GB, which is inside 0.25–4 GB. Learned = 1.00 + 0.3 × (1.41 − 1.00) =
**1.12 GB**, from 1 load. Load with `size_vram < size`: nothing is learned. An observation of
5 GB: discarded and logged.

### Summary

| Device | Chat (4k) pick | Alternative | Coding (16k) pick | Alternative |
|---|---|---|---|---|
| 24 GB RTX 3090 | 32B Q4_K_M, Tight | 14B Q8_0, Fits | 14B Q8_0, Fits | 8B Q8_0, Fits |
| 8 GB card | 8B Q4_K_M, Fits | none | none at 16k; 8B Q4_K_M up to 6k | — |
| 16 GB Mac | 8B Q4_K_M, Fits | none | 8B Q4_K_M, Fits | none |
| 32 GB Mac | 14B Q8_0, Fits | 8B Q8_0, Fits | 14B Q4_K_M, Fits | 8B Q8_0, Fits |

## Planned, not built in step 1

- **Step 2: inventory reporting and the fit engine, test-first.** The new fields above; `fit.ts`
  and its golden tests; `num_ctx` sent on every chat; `device_overhead`. `recommend.ts`'s `fits()`
  and `capacityWords()` (the 1.15 headroom and 0.62 GB per billion parameters) are replaced by the
  engine, so there is one rule.
- **Step 3: the per-device Models screen,** at Settings › Devices › [device] › Models, and the same
  component in device setup. It has a stacked memory-budget bar: loaded models, planned candidates,
  KV cache, overhead, other use and free headroom. It has a quant selector and a context slider that
  recompute live, multi-model planning with an over-budget warning, and "Install and assign" through
  the models subsystem, with no Ollama commands shown. Settings › Models gains an overview of every
  device and where each task routes. **Design first:** a styleguide composition goes to the owner
  for approval before any app code. Declaring the compute role, or Nova finding a GPU, surfaces this
  step in device setup.
- **Step 4: wake on demand for compute devices,** last, with the services track. A sleeping device
  keeps its last inventory and catalog, stamped with their age, and shows as "Asleep, wakeable".
  Routing to it wakes it (`wake.ts`, already built), waits for health, loads the model, runs the
  work, and the device's idle policy (never, or after N idle minutes) returns it to sleep.

## Build order and queue placement

1. This ADR (step 1).
2. Inventory and fit engine, test-first.
3. The Models screen: styleguide composition, owner approval, then the build and the setup hook.
4. Wake on demand, with the services track.

Steps 2–4 come **after the Config Onboarding track**, because device setup lives there. Each step is
its own PR with its own gate, design-first as always.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Ask an LLM whether a model fits | It isn't repeatable, it can't be tested, and it is wrong at the margins where the answer matters |
| Keep today's file size × 1.15 (`recommend.ts`) | It ignores context. A 32B model at 16k needs 4 GB more KV cache than at 4k, which is the difference between Tight and Won't fit on a 24 GB card |
| The tier table as the main rule | It is coarse and can't follow quant or context. It is kept only as the labelled fallback |
| Learn the whole footprint per model, not the overhead | It needs a load of every model before Nova can plan one. Overhead is per device and carries over to new models |
| Learn without bounds | A single bad reading (a partial load, or a KV type Nova didn't know of) would poison every later estimate |
| Sum all GPUs' memory | Wrong unless the backend splits the model. It stays per GPU until splitting is verified |
| Use 0.75 × RAM on every Mac (today's rule) | Reported to be more than macOS allows below 36 GB. It would call models Tight that fail to load |

## Consequences

- One rule decides fit everywhere: recommendations, the Models screen, setup and placement read
  the same engine.
- Verdicts can be trusted only if Nova requests the context it assumed. Step 2 must therefore send
  `num_ctx`, and Ollama's default context no longer applies to Nova's calls.
- A 16 GB Mac is told it can't run a 14B model at the default limit. That is stricter than today and,
  if the 2/3 figure holds, correct.
- The assumed architecture figures and bits per weight are assumptions until the model cards and a
  real load confirm them. The golden tests pin the arithmetic, not the model cards.
- New storage is small: `device_overhead` (replicated to the standby, step 2b), plus more fields in
  the existing `device_hardware` JSON, which stays local to the hub.

## Open questions for the owner

1. The unified-memory budget: 2/3 below 36 GB (this ADR), or keep 0.75 until a real Mac is measured?
   **Answered (owner, 2026-11-06):** on a unified-memory Mac the budget is the Mac's real GPU limit
   when it is known: the device agent reads `sysctl -n iogpu.wired_limit_mb` and reports
   `gpu_wired_limit_bytes` (MB × 1,048,576 when above 0; null at 0, the macOS default, or when it
   can't be read), and the hub keeps it only as a positive whole number of bytes no larger than the
   reported memory. Without it, the fractions above (2/3 below 36 GB, 3/4 from 36 GB) are the
   fallback, labelled on the screen as an estimate. Those fractions are still Nova's estimate of
   Apple's default and haven't been measured on a real Mac. The field lives in the existing
   `device_hardware` JSON, so there is no migration and nothing new is replicated.
2. Should Tight be allowed as the general-chat pick (as in Case 1), or should the pick always be Fits,
   with Tight shown only as an option?
