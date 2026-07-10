---
title: "Inference Backends"
description: "How Nova manages local inference -- bundled Ollama, vLLM, SGLang, and llama.cpp containers, plus external servers like LM Studio -- with hardware detection and one-click switching."
---

Nova manages local inference backend lifecycle for you. Select a backend from the dashboard, and Nova handles pulling the container image, starting it with the right GPU flags, health monitoring, and graceful switching -- no manual Docker Compose profile editing required.

All supported backends expose OpenAI-compatible APIs, and the LLM Gateway's `LocalInferenceProvider` abstracts the active backend so the rest of Nova doesn't need to know which one is running.

## Inference modes (set on first run)

The setup wizard asks once which mode you want, and writes the result to `.env` as `NOVA_INFERENCE_MODE`:

| Mode | Bundled Ollama | Routing strategy | Use when |
|------|----------------|------------------|----------|
| `hybrid` (default) | Pulled and started | local-first | You want local AI with cloud fallback when needed |
| `local-only` | Pulled and started | local-only | Privacy-first or offline-friendly — never call cloud |
| `cloud-only` | Not pulled, not started | cloud-only | Cloud APIs only — lightest setup, no GPU/disk for models |

Switching modes after install is a dashboard task — Settings → AI & Models will let you change mode, swap to an external Ollama / vLLM instance (e.g. `http://192.168.x.y:11434`), and add/remove models without ever touching a script or `.env` file. (UI is in active development; the wizard prompt at first install is the bootstrap fallback while the dashboard isn't running yet.)

Mode is the user-facing knob; under the hood it derives `COMPOSE_PROFILES` (whether the bundled `ollama` Compose service is in the active profile set) and `LLM_ROUTING_STRATEGY` (how the gateway picks providers).

## Backend comparison

| Capability | Ollama | vLLM | SGLang |
|-----------|--------|------|--------|
| **Concurrent batching** | Sequential queue (`OLLAMA_NUM_PARALLEL` limited) | Continuous batching -- interleaves tokens across requests | Continuous batching + RadixAttention |
| **Multi-user serving** | Latency degrades linearly | Near-constant latency up to batch capacity | Best-in-class for shared-prefix workloads |
| **VRAM efficiency** | Loads/unloads full models | PagedAttention -- packs KV caches efficiently | RadixAttention -- caches common prefixes across requests |
| **Model switching** | Hot-swap via `ollama pull`, evicts from VRAM | Single model per instance, switch via drain protocol | Single model per instance, switch via drain protocol |
| **Quantization** | GGUF (widest variety, community models) | GPTQ, AWQ, FP8, GGUF (recent) | GPTQ, AWQ, FP8, GGUF |
| **Structured output** | JSON mode (basic) | Outlines-based JSON schema enforcement | Native JSON schema + regex constraints |
| **CPU inference** | Yes (good) | GPU only | GPU only |
| **Setup complexity** | Single binary, trivial | Python env, more config | Python env, similar to vLLM |
| **Docker image** | `ollama/ollama` | `vllm/vllm-openai` | `lmsysorg/sglang` |

## Why SGLang is interesting for Nova

SGLang's **RadixAttention** automatically caches shared prefixes across requests. In Nova's architecture, every pipeline agent (Context, Task, Guardrail, Code Review) has a system prompt that is identical across all task executions. With 5 parallel tasks running the same pod, that's 20 agent calls sharing large system prompt prefixes.

SGLang caches these in a radix tree -- subsequent requests skip re-computing attention for the shared prefix. This is a significant speedup for exactly Nova's workload pattern of parallel agent pipelines.

## Recommended backend by workload

| Workload | Recommended backend | Why |
|----------|-------------------|-----|
| **Single user, model experimentation** | Ollama | Hot-swap models, widest GGUF library, zero config |
| **Multi-tenant chat** | vLLM or SGLang | Continuous batching handles concurrent users efficiently |
| **Parallel agent pipelines** | SGLang | RadixAttention prefix caching across agents sharing system prompts |
| **CPU-only / edge deployment** | Ollama | Best CPU performance among managed backends |
| **Coding sessions (multiple concurrent)** | vLLM or SGLang | Long contexts + concurrent requests need batching |

:::note
llama.cpp ships as a bundled backend (`inference-llamacpp`), serving a GGUF file from `LLAMACPP_MODELS_DIR`. For CPU-only deployments, Ollama remains the easiest option.
:::

## Managed backends

Nova bundles four backends -- **Ollama**, **vLLM**, **SGLang**, and **llama.cpp**. Each is a Docker Compose service behind a profile (`inference-ollama`, `inference-vllm`, `inference-sglang`, `inference-llamacpp`), and the recovery service manages its lifecycle. Several containers can be warm at once; `inference.backend` picks the one the gateway routes to, so switching between running backends is instant.

Model storage is configurable so you can reuse existing model stores instead of re-downloading:

| Backend | Env var | Default | Container mount |
|---|---|---|---|
| Ollama | `OLLAMA_MODELS_DIR` | `./data/models/ollama` | `/root/.ollama` (point at `~/.ollama` to reuse) |
| vLLM / SGLang | `HF_CACHE_DIR` | `./data/models/hf` | HuggingFace cache (point at `~/.cache/huggingface`) |
| llama.cpp | `LLAMACPP_MODELS_DIR` + `LLAMACPP_MODEL` | `./data/models/gguf` | `/models` (GGUF files) |

GPU access comes from the `docker-compose.gpu.yml` overlay, activated with `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`. The installer writes this line only after positive NVIDIA detection (it hard-fails `docker compose up` on hosts without nvidia-container-toolkit — recovery is deleting the line). vLLM and SGLang starts are refused on CPU-only hosts; Ollama and llama.cpp run fine on CPU.

LM Studio is a desktop app and **Custom** is any OpenAI-compatible URL — both stay external-only (no container).

| Backend | Profile | Container | Port | Status |
|---------|---------|-----------|------|--------|
| Ollama | `local-ollama` | `nova-ollama` | 11434 | Managed |
| vLLM | `local-vllm` | `nova-vllm` | 8000 | Managed |
| SGLang | `local-sglang` | `nova-sglang` | 8000 | Managed |

Users do not set `COMPOSE_PROFILES` manually for inference backends. The recovery service starts and stops profiled services via its Docker Compose integration.

### Starting and stopping bundled containers

Bundled engines are controlled with a **Start/Stop toggle** in two places — the **Models** page (under *Local Inference*, next to where you pull and manage models) and **Settings → AI & Models → Local Inference**. Both surface the same control: each backend shows a health dot, an *active* badge for the one the gateway is routing to, and a *needs GPU* badge for vLLM/SGLang on CPU-only hosts. Starting a container routes Nova's local inference to it; several can run at once.

The toggle is the **source of truth** for which bundled engines run. Re-running `./install` no longer overrides it — the deployment mode only seeds the default (bundled Ollama) on a *fresh* install, and your other enabled profiles (browser, voice, knowledge, observability) are preserved across re-runs.

Because the bundled images are pinned to `:latest`, starting a backend does a **best-effort image pull first** so a stale cached engine can't block current models (e.g. Ollama's `412: requires a newer version` error). The pull is non-fatal — an offline host simply starts from the cached image.

LM Studio is also a first-class backend but is **not** container-managed -- see [LM Studio](#lm-studio).

## Hardware detection

Nova detects your hardware at two points:

1. **Setup time** -- `setup.sh` runs GPU detection on the host and writes results to `data/hardware.json`
2. **Runtime** -- the recovery service reads `data/hardware.json` on startup and syncs it to Redis (`nova:system:hardware` on db7)

Detection covers:

- GPU vendor (NVIDIA via `nvidia-smi`, AMD via `rocm-smi`)
- GPU model and VRAM per device
- Available Docker GPU runtime (`nvidia-container-toolkit`, ROCm)
- CPU cores, total RAM, free disk space

The dashboard uses these results to recommend a backend:

| Hardware | Recommendation |
|----------|---------------|
| NVIDIA GPU with 8+ GB VRAM | vLLM |
| AMD GPU (ROCm) | vLLM (ROCm build) |
| CPU only | Ollama |
| No local hardware | Cloud providers |

## Managing models (dashboard → Models)

The **Models** page groups everything under a **Local Inference** heading, with **one section per local backend that is active or reachable** — so an Ollama store and an LM Studio store show side by side, each labeled **Active — serving Nova** or **Available**. This is deliberate: switching the active backend no longer looks like "the same models", because each store is named and badged separately.

### On disk / in memory

Every backend renders the same table: each model shows its size, a **state** (`on disk` / `in memory`), and a **Load/Unload** control. Local backends lazily load and evict models, so "downloaded" and "resident" are different facts — the table surfaces both. Ollama gains explicit Load/Unload (via `/api/generate` warm-up and `keep_alive=0` eviction) to match LM Studio's JIT load/unload; loaded state comes from Ollama's `/api/ps` and LM Studio's `/api/v0/models` (`state == "loaded"`).

Each backend differs only in how you **acquire** models: Ollama pulls from its registry in-app; LM Studio has no download API, so you download in the LM Studio desktop app and the models appear here once present.

### Recommended models

The "Add models" area offers a recommendation grid with two sources:

- **Popular on Ollama** (default) — the live `ollama.com/library` popularity ranking, enriched with real download sizes from the Ollama registry manifest, parameter variants, and a deep link per model (6-hour cache).
- **Curated** — Nova's opinionated picks (including the `openbmb/minicpm5` starter), the offline fallback when the live scrape is unavailable.

Recommendations default to **models that fit this machine, plus all cloud models** — the size cap is the GPU's VRAM (or system RAM on CPU-only hosts); a "show all sizes" link lifts it. The filter compares each model's **default-tag** size.

### Recommended cloud models

The Cloud Providers section leads with a curated **Recommended cloud models** panel grouped by job (frontier / cheap / code / free), each showing input+output **$/Mtok**, context window, and a note. Configured providers get a one-click **Use** (sets the chat model); unconfigured ones link to add a key. Prices are curated estimates (no provider exposes a uniform pricing API) and dated.

### Serving endpoints

Recovery serves the curated data (bind-mounted, editable without a rebuild):

| Endpoint | Purpose |
|----------|---------|
| `GET /inference/models/recommended?backend=&source=popular\|curated` | Local recommendations (curated file or live ollama.com) |
| `GET /inference/models/recommended-cloud` | Curated cloud picks with pricing |
| `GET /inference/hardware` | Detected GPU/RAM/disk (drives the GPU-fit filter) |

## Backend lifecycle

The recovery service manages the full lifecycle of inference containers using Docker Compose profiles.

### Starting a backend

When you select a backend in the dashboard:

1. If a different backend is already running, Nova drains and stops it first (see [backend switching](#backend-switching-protocol))
2. Recovery sets `nova:config:inference.state` to `starting` and `nova:config:inference.backend` to the selected backend
3. Recovery starts the profiled Compose service with the correct GPU flags
4. Recovery polls the container's health endpoint until it responds (up to 120s timeout)
5. State is set to `ready` -- the LLM Gateway begins routing to the new backend
6. A background health monitor starts checking the container every 30 seconds

Container images are pulled lazily on first backend selection, not at install time. This requires internet access for the initial pull.

### Health monitoring

The recovery service runs a background health check every 30 seconds against the active inference container. After 3 consecutive failures:

1. Recovery attempts to restart the container
2. On success, health counter resets and state returns to `ready`
3. On failure, backoff increases exponentially (30s, 60s, 120s) and state is set to `error`

The dashboard shows the current backend state -- users can see if their backend is running, starting, or in an error state.

### Stopping a backend

Stopping follows the drain protocol described below, then stops the Compose service and sets the backend to `none`.

## Backend switching protocol

When switching from one backend to another (e.g., Ollama to vLLM):

1. Recovery sets `nova:config:inference.state` to `draining`
2. The LLM Gateway reads this state on its next config refresh (5s cache TTL) and stops routing new requests to the local backend -- new requests fall back to cloud providers (if configured) or return 503
3. Recovery polls the gateway's `GET /health/inflight` endpoint, waiting up to **15 seconds** for in-flight local requests to complete
4. After drain completes (or timeout expires), recovery stops the old container
5. Recovery starts the new container and waits for its health endpoint to respond
6. State transitions: `starting` then `ready`
7. The gateway detects the new backend and begins routing to it

If the new backend fails to start within 120 seconds, state is set to `error`. Cloud fallback continues to serve requests, and the dashboard shows the failure.

## Configuration

All inference backend settings are configured through the dashboard UI and stored in Redis -- not in `.env` files.

### Redis keys

| Key | Purpose | Values |
|-----|---------|--------|
| `nova:config:inference.backend` | Active backend | `ollama`, `vllm`, `sglang`, `lmstudio`, `custom`, `none` |
| `nova:config:inference.state` | Lifecycle state | `ready`, `starting`, `draining`, `error`, `stopped` |
| `nova:config:inference.url` | Backend URL override (Ollama/vLLM/SGLang) | Empty = use default for backend |
| `nova:config:inference.lmstudio_url` | LM Studio server URL | Empty = `http://host.docker.internal:1234` |
| `nova:config:inference.lmstudio_api_key` | LM Studio server API key (optional) | Empty = no auth |
| `nova:config:llm.embed_provider` | Embedding provider override | `auto` (route by model name), `lmstudio`, `ollama`, `gemini`, `litellm` |
| `nova:config:llm.embed_model` | Model name sent to the embedding provider | Used when `llm.embed_provider` is set |
| `nova:system:hardware` | Detected hardware info | JSON (GPU, CPU, RAM, disk) |

### What stays in .env

Only bootstrap and security settings:

- `POSTGRES_PASSWORD`, `ADMIN_SECRET`, `NOVA_WORKSPACE`
- `DEFAULT_CHAT_MODEL` -- initial default, overridden by UI after first use
- API keys -- also settable via the dashboard, `.env` is a fallback for headless deploys

## Integration with LLM Gateway

The LLM Gateway uses a `LocalInferenceProvider` that wraps whichever backend is currently active.

### How it works

1. `LocalInferenceProvider` reads `nova:config:inference.backend` and `nova:config:inference.state` from Redis (cached for 5 seconds)
2. Based on the backend value, it creates and delegates to the appropriate provider class:
   - `OllamaProvider` for Ollama
   - `VLLMProvider` (extends `OpenAICompatibleProvider`) for vLLM
3. If the backend changes, the delegate is recreated on the next config refresh -- requests already in-flight on the old delegate complete normally
4. If state is `draining`, `starting`, `error`, or the backend is `none`, `is_available` returns `False` and routing skips local, falling through to cloud

### Provider classes

| Class | Protocol | Notes |
|-------|----------|-------|
| `OpenAICompatibleProvider` | OpenAI `/v1/chat/completions`, `/v1/embeddings` | Base class for vLLM, SGLang, and LM Studio |
| `VLLMProvider` | Extends above | Thin wrapper -- vLLM speaks native OpenAI format |
| `SGLangProvider` | Extends above | Thin wrapper -- SGLang speaks native OpenAI format with RadixAttention benefits |
| `LMStudioProvider` | Extends above | Host-side desktop app; health-checked via `/v1/models`; URL/key runtime-configurable |
| `RemoteInferenceProvider` | Extends above | For user-managed OpenAI-compatible servers (custom URL + optional auth) |
| `OllamaProvider` | Ollama API | Existing provider, unchanged |

### Local model detection

The `LocalInferenceProvider` maintains a set of models discovered from the active backend's `/v1/models` endpoint. Any model in that set is treated as "local" for routing strategy purposes. This replaces the old hardcoded model list. The set refreshes on backend changes and periodically during discovery runs.

### Routing strategies

The existing routing strategies -- `local-first`, `cloud-first`, `local-only`, `cloud-only` -- work unchanged. The difference is that "local" now means whichever managed backend is active, rather than a hardcoded Ollama instance.

Fallback chain: `LocalInferenceProvider` (active backend) then cloud providers.

## Embeddings

Embeddings are **decoupled from chat**. Memory-service calls the gateway's `POST /embed` with a model name, and the gateway resolves the provider independently of `inference.backend`. By default the embedding model is `nomic-embed-text` (routed by name to Ollama) -- selecting LM Studio for chat does not re-point embeddings at it.

### The single-model constraint

LM Studio and Ollama are single-model local servers: each embed call evicts the currently-loaded chat model (a 1-5s reload). To avoid this, **don't run chat and embeddings on the same local server**. Pair them across two servers, or use a cloud embed model:

| Chat | Embeddings | Notes |
|------|-----------|-------|
| LM Studio (local model) | LM Studio (cloud model) | One local model in VRAM; LM Studio proxies the cloud embed model. `llm.embed_provider=lmstudio` |
| LM Studio (cloud model) | LM Studio (local model) | Inverse of above |
| LM Studio (local) | Ollama (`nomic-embed-text`) | Tiny (~270MB) embed model stays resident in Ollama; zero chat impact. `llm.embed_provider=ollama` (or `auto`) |
| Ollama | LM Studio (local) | `llm.embed_provider=lmstudio` |

### Embedding provider override

Because a model name can only map to one provider in the registry, routing embeddings through LM Studio (even for a cloud model LM Studio proxies) requires an explicit override. Set it in Settings \u2192 AI & Models \u2192 Embedding Model:

- `llm.embed_provider` -- `auto` (default; route by model name) or a provider slug (`lmstudio`, `ollama`, `gemini`, `litellm`)
- `llm.embed_model` -- the model name to send to that provider (used when the override is active)

:::caution
Embeddings must match memory-service's `EMBEDDING_DIMENSIONS` (default **768**). Use a 768-dim model (e.g. `nomic-embed-text`) unless you've reconfigured memory-service and re-embedded existing memories -- mixing dimensions breaks pgvector similarity queries.
:::

## SGLang

SGLang is Nova's third managed backend, optimized for workloads with shared prefixes -- exactly Nova's agent pipeline pattern.

Nova manages SGLang identically to vLLM: the recovery service starts the `nova-sglang` container via the `local-sglang` Docker Compose profile, monitors health, and handles lifecycle transitions. SGLang is a single-model-per-instance backend, so model switching uses the same drain protocol as vLLM (see [Model switching](#model-switching)).

The `SGLangProvider` extends `OpenAICompatibleProvider` in the LLM Gateway, so it supports chat, streaming, embeddings, function calling, and structured output out of the box.

Configuration is done entirely through the dashboard -- select SGLang from the Local Inference section in Settings, and Nova handles the rest.

## LM Studio

[LM Studio](https://lmstudio.ai) is a desktop GUI app (macOS/Windows/Linux) that runs models locally and exposes an OpenAI-compatible server. Unlike Ollama/vLLM/SGLang, **Nova does not manage the LM Studio process** -- you start it yourself. Nova discovers loaded models via `/v1/models` and, on LM Studio 0.4.0+, can **load and unload models** from your downloaded library without touching the GUI.

This makes LM Studio ideal for users who already run it on their host (e.g. Nova in WSL/Docker while LM Studio runs on Windows). The gateway reaches it at `http://host.docker.internal:1234` by default; override the URL in Settings for a remote LM Studio box.

LM Studio is multi-model and user-managed (like Ollama), **not** single-model switchable (unlike vLLM/SGLang) -- there is no model-switch path.

### Setup

1. Install LM Studio from [lmstudio.ai](https://lmstudio.ai)
2. Open the **Developer** tab \u2192 **Start Server** (port 1234)
3. Download a model in LM Studio (you can also load one in the GUI, but see below)
4. In Nova: Settings \u2192 AI & Models \u2192 Local Inference \u2192 select **LM Studio**
5. (Optional) Set a server API key in LM Studio and enter it in the Nova settings card

The settings card shows a live connection status, loaded models, and a Test Connection button. Because the recovery container has no `host.docker.internal` mapping, status is probed through the gateway's `GET /health/providers/lmstudio/status` endpoint.

### The Models Library (load & unload on demand)

When LM Studio is the active backend, the **Models** page shows a dedicated **LM Studio Models** section that lists every model you've *downloaded* -- not just the ones currently loaded. For each model you see its parameter size, quantization, max context, capabilities (vision/tools/embedding), size on disk, and whether it's currently in memory.

- **Load** brings a downloaded model into memory and immediately registers it with the gateway so it's routable from Nova (a loaded model can serve chat via `/v1/chat/completions`).
- **Unload** frees the memory it occupied.
- Use **Refresh** to re-sync after you download or load models in the LM Studio GUI.

This uses LM Studio's native v1 REST API (`GET /api/v1/models`, `POST /api/v1/models/load`, `POST /api/v1/models/unload`), which is available in **LM Studio 0.4.0+**. On older builds, the library gracefully falls back to the OpenAI-compatible `/v1/models` endpoint -- the list still renders (showing loaded models) but the load/unload buttons aren't available; load models from the LM Studio GUI instead.

### Onboarding

LM Studio appears as an engine option in the first-run wizard **only when** a probe to the server succeeds -- users never see a dead choice.

## Custom endpoints

For backends Nova doesn't manage (llama.cpp, a remote vLLM instance, etc.), configure them as custom OpenAI-compatible endpoints via the Settings UI.

The `RemoteInferenceProvider` connects to any OpenAI-compatible server at a user-specified URL. Optional authentication is supported via a configurable auth header value. Custom endpoints are registered through the dashboard's Local Inference settings under the "Custom" backend option, where you provide the server URL and optional authentication.

The `LocalInferenceProvider` handles custom endpoints alongside the other backend types -- when the backend is set to `custom`, it delegates to `RemoteInferenceProvider` with the configured URL and auth. Custom endpoints participate in the same routing strategies as managed backends.

## Model switching

vLLM and SGLang are single-model-per-instance backends -- unlike Ollama, they cannot hot-swap models. To switch models, Nova uses the drain protocol:

1. The dashboard sends `POST /recovery-api/api/v1/recovery/inference/backend/{backend}/switch-model` with the new model ID
2. Recovery sets the inference state to `draining`
3. The LLM Gateway stops routing new requests to the local backend (cloud fallback continues serving)
4. Recovery polls `GET /health/inflight` until in-flight requests complete (up to 15s)
5. Recovery stops the container, updates the model configuration, and restarts with the new model
6. State transitions through `starting` to `ready` once the new model is loaded and healthy

Users can search for models via the Models page, which queries HuggingFace (for vLLM/SGLang) or the Ollama registry. The search endpoint (`GET /recovery-api/api/v1/recovery/inference/models/search`) returns results with VRAM estimates to help users choose models that fit their hardware.

## Onboarding wizard

First-time users are guided through a 6-step onboarding wizard that configures their inference backend:

1. **Welcome** -- introduction to Nova's local AI capabilities
2. **Hardware detection** -- scans for GPU, VRAM, CPU, and RAM
3. **Engine selection** -- recommends a backend based on detected hardware
4. **Model selection** -- suggests models that fit the available VRAM, with curated recommendations
5. **Download** -- pulls the selected model (with progress tracking)
6. **Ready** -- confirms setup and launches the main UI

The wizard can be re-run at any time from Settings. It stores completion state so it only appears on first visit.

## GPU monitoring

When an NVIDIA GPU is available, the dashboard displays live GPU stats (utilization, VRAM usage, temperature, power draw) via the `GET /recovery-api/api/v1/recovery/hardware/gpu-stats` endpoint. The recovery service obtains these stats by running `nvidia-smi` inside the GPU-enabled inference container using Docker exec.

GPU stats cards appear on the Models page when a local backend is active, giving users real-time visibility into their inference hardware.

## Model recommendations

Nova provides intelligent model recommendations based on detected hardware:

- **Curated list** -- a set of recommended models is maintained in `data/recommended_models.json`, organized by category (general, coding, small/fast) with VRAM requirements
- **`GET /recovery-api/api/v1/recovery/inference/models/recommended`** -- returns the curated list, filtered by available VRAM
- **`GET /recovery-api/api/v1/recovery/inference/recommendation`** -- auto-recommends a backend and model based on hardware detection (GPU vendor, VRAM, CPU-only fallback)

The recommendation endpoint considers:

| Hardware | Recommended backend | Recommended model |
|----------|-------------------|------------------|
| NVIDIA GPU, 8+ GB VRAM | vLLM or SGLang | Largest model that fits in VRAM |
| NVIDIA GPU, <8 GB VRAM | Ollama | Quantized model (GGUF) fitting VRAM |
| AMD GPU (ROCm) | vLLM (ROCm build) | Based on available VRAM |
| CPU only | Ollama | Small quantized model |
| No local hardware | Cloud providers | No local model recommended |

The dashboard shows a recommendation banner on the Models page and uses these recommendations in the onboarding wizard.
