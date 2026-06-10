# Recommended Models — Design (v1 feature restore + capability gauges)

**Date:** 2026-06-10
**Status:** Approved for implementation (autonomous session; review surface = PR)
**Author:** Claude (directed by Jeremy)

## Why

Jeremy's brief, distilled:

> Ship Nova with a list of recommended LLMs that will actually work with it — pulled
> down from Ollama with one click, filtered by the machine's GPU and resources, like
> v0.1.0-alpha had. If a model will absolutely be an issue, it should not be
> recommended. The list should be dynamic. Each model gets a little gauge showing how
> capable it is — especially for tool calling and agent tasks in Nova — so models are
> easy to compare. Cloud models can be included but visually separated from local ones.

Today v2 has none of this. The install wizard free-texts a model name (default
`llama3.2`) with zero validation; `llm-gateway/app/discovery.py` only lists what is
already installed; cloud model lists are hardcoded in the same file; and nothing
anywhere checks whether a model supports tool calling — which Nova's entire agent loop
depends on (see the litellm JSON-coercion fix, `3fea0a6`). A user who picks a
non-tool-calling model gets an agent that silently can't act.

## Review findings

### What v0.1.0-alpha had (tag `v0.1.0-alpha`)

| Feature | v1 implementation | Verdict |
|---|---|---|
| Hardware detection | Two-phase: `scripts/detect_hardware.sh` on host at setup (nvidia-smi/rocm-smi, CPU, RAM, disk) → `data/hardware.json`; `recovery-service/app/inference/hardware.py` synced to Redis, served `/hardware`, `/hardware/gpu-stats` (live VRAM bar) | **Port.** The two-phase approach is right — GPU tools don't exist inside containers. |
| Hardware-aware recommendation | `get_full_recommendation()`: backend pick (GPU+8GB → vLLM, else Ollama), then filter curated list by `min_vram_gb <= total_vram` | **Port,** extended with RAM-based filtering for CPU-only boxes. |
| Curated list | **Two duplicated lists**: `data/recommended_models.json` (12 models, backend) and `RECOMMENDED_OLLAMA_MODELS` in `dashboard/src/constants.ts` (~36 models, frontend). Both hardcoded. | **Port the content, fix the duplication.** One manifest, served by API. |
| One-click pull | Models page grid → `POST /v1/models/ollama/pull` (llm-gateway); pulled/pulling/delete states per card | **Port.** Add real download progress (Ollama streams it; v1 showed only a spinner). |
| Models page | `dashboard/src/pages/Models.tsx` (1067 lines): GPU stats card w/ VRAM bar, installed table w/ delete, free-text pull, recommended grid w/ category + max-size filters, color-coded size badges | **Port the layout concepts** under v2's DESIGN.md. |
| Model search | `model_search.py`: HuggingFace API for vLLM/SGLang with VRAM estimates; Ollama returned `[]` — *"Ollama doesn't have a public search API"* | **Port HF search later (vLLM path); confirms Ollama can't be scraped live.** |
| Capability info | None. Closest was "function calling" in hermes3's description string. Cloud models mixed into the grid with a small badge. | **Net-new:** gauges, tool-call verification, real local/cloud separation. |

### What v2 has today (and must not be disturbed)

- `llm-gateway/app/discovery.py` — read-only discovery of installed models per backend
  (Ollama `/api/tags`, OpenAI-compat `/v1/models`), 5-min cache, hardcoded cloud lists.
- agent-core proxies llm-gateway for the dashboard (`/api/v1/llm/providers`,
  `/api/v1/llm/config`) — the pattern to extend, since production nginx does not proxy
  `/v1/` (known gap).
- The install wizard's backend picker (host-Ollama detection, six engine choices).
- Secrets vault for cloud API keys; provider availability already reflects key presence.

### The gaps, in Jeremy's terms

1. **"Models that will work with Nova"** — nothing verifies tool-calling support; the
   default recommendation path can produce a broken agent.
2. **"Recommended based on my hardware"** — v2 has zero hardware detection.
3. **"One click to pull"** — v2 has no pull/delete endpoints at all.
4. **"Dynamic list"** — v1's lists were hardcoded in two places and went stale.
5. **"Easy to compare"** — no capability signal anywhere, local or cloud.

## Design

### Approaches considered

- **A. Scrape ollama.com for a live catalog.** Rejected — no public API (v1 reached the
  same conclusion); the HTML search endpoint is undocumented and brittle.
- **B. Hardcode the list again, but in one place.** Cheapest, but repeats v1's staleness
  failure — the list was already out of date by the time v1 was tagged.
- **C. Bundled manifest + remote refresh + live verification (chosen).** A curated
  manifest ships with Nova (works offline), llm-gateway refreshes it from the repo's
  raw GitHub URL on a TTL (dynamic without scraping — update one file in the repo and
  every install gets it), and installed models are verified live against Ollama's
  `/api/show` capabilities plus a one-shot tool-call probe (ground truth for "will
  absolutely be an issue").

### Manifest (single source of truth)

`llm-gateway/data/recommended_models.json`, served by API — the dashboard hardcodes
nothing. Schema per entry:

```jsonc
{
  "ollama_id": "qwen2.5:7b",            // pull target; null for HF-only entries
  "hf_id": "Qwen/Qwen2.5-7B-Instruct",  // vLLM/SGLang target; null if ollama-only
  "name": "Qwen 2.5 7B",
  "category": "general",                 // general | reasoning | code | vision | embedding
  "roles": ["completion", "extraction"], // which Nova roles it can fill
  "size_gb": 4.4,                        // download size
  "min_vram_gb": 6,                      // GPU path
  "min_ram_gb": 8,                       // CPU-only path
  "capabilities": { "tools": true, "vision": false },
  "scores": {                            // 0–5 curated, benchmark-informed
    "agent": 4,                          // tool calling / agent tasks in Nova — headline
    "reasoning": 3,
    "coding": 3,
    "speed": 4                           // relative; UI annotates with hardware context
  },
  "description": "Multilingual, strong all-rounder.",
  "default": false,                      // wizard default for matching hardware tier
  "cloud": false                         // true → rendered in the cloud section
}
```

Plus a top-level `denylist`: models that must never be recommended for the completion
role, each with a `reason` shown if the user has one installed (e.g. `deepseek-r1:*` —
no tool support in Ollama; fine for reasoning side-tasks, breaks the agent loop as the
default model). Denylisted ≠ hidden: an installed denylisted model appears in the
installed table with a warning badge, it just never appears under "Recommended".

Cloud entries (Anthropic/OpenAI/Gemini/Groq models, Ollama `:cloud` tags) live in the
same manifest with `"cloud": true` and the same `scores` block, so the gauges make
local-vs-frontier comparison direct. This also removes the hardcoded lists from
`discovery.py`.

**Seeding:** start from v1's two lists (deduplicated, refreshed against what is current
on ollama.com at implementation time), with roles assigned per CLAUDE.md guidance —
small models tagged `extraction` (the `qwen2.5:1.5b`-on-CPU advice becomes data),
`nomic-embed-text` et al. tagged `embedding` and marked required.

### Remote refresh ("dynamic")

- llm-gateway fetches the manifest from the repo's raw GitHub URL (main branch) every
  24 h, in-memory + on-disk cache, bundled copy as permanent fallback. Offline boxes
  simply use the bundled list. Failure is a `logger.warning`, never an error.
- Manifest carries a `schema_version`; gateway ignores newer majors (old Nova won't
  choke on a future manifest shape).

### Live verification (the "absolutely an issue" gate)

For every installed Ollama model:

1. `POST /api/show` → `capabilities` array. No `"tools"` → marked `tools: false`
   regardless of what the manifest claims.
2. Optional one-shot probe (on first install + manual re-run): a single completion with
   one trivial tool defined; pass = the model emits a well-formed tool call. Result
   cached per model+digest.
3. A model failing either check: agent gauge overridden to 0 with "failed tool-call
   check on this machine"; blocked (with override) from selection as
   `LOCAL_COMPLETION_MODEL`.

This piece lands first, inside the **proactivity increment**, as its safety
prerequisite — proactive autonomous cycles must not run on a model that can't reliably
tool-call. The rest of this spec is its own increment.

### Hardware detection

- Port `detect_hardware.sh` (v1) into `./install`: writes `data/hardware.json`
  (GPUs + VRAM, CPU cores, RAM, disk free). Mounted read-only into llm-gateway.
- `GET /hardware` (llm-gateway): file contents + live best-effort signals (container
  RAM/CPU; Ollama `/api/ps` for VRAM-in-use). No GPU tooling inside containers — the
  file is authoritative for capacity, live calls only for utilization.
- Fit rule: GPU present → `min_vram_gb <= total_vram`; CPU-only → `min_ram_gb <= ram_gb`
  with a "will be slow" annotation above ~7B (the dev-box lesson: qwen2.5-coder:7b at
  >90 s/response on CPU).

### API surface

llm-gateway (new):

```
GET    /models/recommended      # manifest ∩ hardware fit ∩ installed-state ∩ verification
GET    /models/pulled           # installed Ollama models w/ size, digest, verification
POST   /models/pull             # {model} → SSE progress (proxied from Ollama's NDJSON)
DELETE /models/{name}
GET    /hardware
POST   /models/{name}/verify    # re-run the tool-call probe
```

agent-core proxies all of these under `/api/v1/llm/models/*` and `/api/v1/llm/hardware`
(same pattern as the memories proxy) so the dashboard works in production without
waiting on the nginx `/v1/` fix.

### Dashboard — Models page

Layout per DESIGN.md (read it before implementation; no visual decisions are made
here). Structure restored from v1, reorganized into **two clearly separated sections**:

1. **Local models**
   - Hardware header: GPU name + VRAM bar (live), RAM, disk free; CPU-only notice when
     no GPU.
   - Installed table: size, verification state, delete; warning badge on denylisted or
     probe-failed models.
   - Recommended grid: filtered to "fits your hardware" by default (toggle to show
     all, oversized dimmed), category filter chips (general/reasoning/code/vision/
     embedding), one-click pull with streamed progress bar, pulled ✓ state.
2. **Cloud / frontier models**
   - Grouped by provider, availability keyed off configured secrets; Ollama `:cloud`
     models live here, not in the local grid.
   - Same card + gauge component as local — that's what makes comparison work.

**Capability gauge:** one compact component per card — four labeled segments (Agent /
Reasoning / Coding / Speed), 0–5 fill, with Agent first and visually dominant. Probe
results decorate it ("verified on this machine" / failure note). Free-text pull box
stays for power users, with an inline warning if the typed model is denylisted.

### Install wizard

Replace the free-text model prompt: read `hardware.json` + manifest, present the top
3–4 fitting models (default preselected), set `LOCAL_COMPLETION_MODEL`,
`EXTRACTION_MODEL`, and `LOCAL_EMBED_MODEL` in one pass from the same data. Free-text
escape hatch remains.

### Error handling

- Manifest fetch failure → bundled copy, `logger.warning`, staleness noted in API
  response (`manifest_source: "bundled" | "remote"`, `fetched_at`).
- Ollama unreachable → recommended grid still renders (manifest is local); pull
  buttons disabled with the existing "Ollama offline" treatment.
- Pull failures surface Ollama's error text on the card, card returns to pullable.
- Probe timeouts (CPU boxes) → "unverified", never "failed"; verification is
  best-effort, the `/api/show` capability check is the hard gate.

### Testing (real services, no mocks)

- `test_model_recommendations.py`: manifest loads + validates; `/models/recommended`
  filters by a synthetic `hardware.json` (no-GPU vs 8 GB vs 24 GB fixtures); denylisted
  model never appears; installed-state merge correct.
- Pull lifecycle against real Ollama: pull a tiny model (`qwen2.5:0.5b`), assert SSE
  progress events, presence in `/models/pulled`, delete, absence.
- Capability gate: assert a known no-tools model is flagged and refused as completion
  default; assert the configured default model passes `/api/show`.
- Dashboard: Playwright per the regression gate — pull from the grid, watch progress,
  verify gauge renders, verify cloud section separation.

### Out of scope (this increment)

vLLM/llamacpp automated downloads (entries list HF ids; no pull API — manual flow
documented on the card), HuggingFace live search (port later if vLLM usage demands it),
benchmark automation for scores (curated by hand in the manifest), multi-user anything.

## Sequencing

1. **Proactivity increment** (next, as agreed) absorbs the live-verification gate
   (`/api/show` check + probe + completion-model block) — its safety prerequisite.
2. **This increment** follows: manifest + remote refresh + hardware detection + pull
   endpoints + Models page + wizard integration. Before the web increment.
