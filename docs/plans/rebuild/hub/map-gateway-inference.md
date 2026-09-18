## Local inference in v4: how the stack reaches ollama today

### 1. Configuration: one env var, pointed at the container, not editable at runtime
- **Env var:** `OLLAMA_URL`. It is set only on the gateway, to `http://ollama:11434` (`deploy/docker-compose.yml:79`). The code has no default: an unset value gives a 502 "OLLAMA_URL is unset" (`services/gateway/app/adapters/ollama.py:309,331,348`, `admin.py:181,215,400`).
- **How the address resolves:** `providers.base_url_of()` returns `os.environ["OLLAMA_URL"]` for any row whose `adapter == "ollama"`. The stored column is ignored (`services/gateway/app/providers.py:82-92`, `to_public` at `:74`).
- **The builtin row:** migration 003 seeds `('ollama','ollama','','none',builtin=true,is_default=true)` (`services/gateway/migrations/003_providers.sql:50`). `base_url` is empty by design (`:18-20`). Startup re-seeds it through `ensure_builtin` (`providers.py:222-237`, `main.py:39`). Migration 005 set `local=true` for adapter `ollama` (`005_usage.sql:11-12`), and `insert_row` sets `local = (adapter='ollama')` (`providers.py:274`).
- **Editing is blocked everywhere:**
  - `PUT /admin/providers/ollama` returns 400 "configured by the install, not edited" (`admin.py:745-749`).
  - `POST` with `name=ollama` returns 409 (`admin.py:702-703`).
  - A non-builtin row cannot use adapter `ollama`. The error text itself says "another ollama's /v1 use adapter=openai-chat" (`providers.py:128-133`).
  - The builtin row cannot be deleted (`providers.py:358-359`).
  - The web UI hides Re-verify and Remove for builtin rows (`apps/web/src/pages/settings/ProvidersSection.tsx:621,638`).
- **The ollama container:** it sits behind `profiles: ["inference"]` (`deploy/docker-compose.yml:215`) and publishes `127.0.0.1:11434` (`:217`), volume `v4_ollama` (`:219`). The GPU override reserves devices for both `ollama` and `gateway` (`deploy/docker-compose.gpu.yml:24-31,50-56`).
- **Installer:** `OLLAMA_PORT=11434` (`deploy/install.sh:41`). `decide_inference` handles `NOVA_SKIP_INFERENCE=1` by telling the user to choose "Remote endpoint" (`:246-251`). Its port-conflict help points at `http://host.docker.internal:11434 (or this host's LAN address)` (`:316-318`). It also detects the GPU via host `nvidia-smi` into `hardware.json` (`:641-671`).

### 2. The "remote" kind that already exists, and its limits
- The `/admin/backend` legacy view (`services/gateway/app/backends.py`) has kinds `ollama|remote|cloud` (`:20`). The kind is derived from the default provider row: builtin → `ollama`, openai-chat with no auth → `remote` (`:30-38`).
- Saving `kind=remote` upserts a provider row named `remote`, with `adapter=openai-chat`, `{url}/v1` and `auth_shape=none` (`:118-136`). It is verified before save (`:139-151`).
- The wizard offers "Bundled Ollama / Remote endpoint / Cloud" (`apps/web/src/pages/onboarding/steps/ChooseEngine.tsx:14-34`). The Downloading step is skipped for remote (`steps.ts:64`).
- **What that row loses:** it is `local=false`. So the Dell's ollama reached this way:
  - gets no `/api/tags` or `/api/show` catalogue rows;
  - cannot be pulled to (`admin.py:389-396` refuses unless the default kind is `ollama`);
  - cannot have models removed (`admin.py:1141-1142` hardcodes the builtin row);
  - reports no resident models and no VRAM (`admin.py:170-178,209-217`);
  - is metered as non-local, so USD caps apply (`usage.py:315,651`);
  - gets no installed check during routing (`routing.py:345`);
  - makes routing treat the chain as having no local link, so it falls back to the builtin standby (`routing.py:459-460`).
- v3 precedent (a source to borrow from only): the runtime setting `inference.ollama_url` (`backend/app/llm/router.py:191`, `backend/app/models_catalog.py:23`), separate from `bundled_ollama_url` (`backend/app/config.py:40-42`).

### 3. Every direct call to ollama

**Gateway** (all through `base_url_of`):

| Path | Where | Timeout |
|---|---|---|
| `GET /api/tags` | `adapters/ollama.py:306-326` | `MODELS_TIMEOUT` 10s total (`adapters/base.py:15`) |
| `GET /api/version` (verify) | `adapters/ollama.py:328-343` | 10s |
| `POST /api/show` | `adapters/ollama.py:107-130`; fan-out ≤4 (`:64`); cache keyed by digest (`:69`); catalogue deadline 15s (`catalog.py:306`) | 10s |
| `DELETE /api/delete` | `adapters/ollama.py:133-146` | 10s |
| Chat `{OLLAMA_URL}/v1/chat/completions` | re-dressed as openai-chat (`adapters/ollama.py:345-352`) | `COMPLETIONS_TIMEOUT` connect 5s / read 300s (`adapters/base.py:14`) |
| `GET /api/ps` | `admin.py:110-138` | `PS_TIMEOUT` 5s (`admin.py:69`) |
| `POST /api/pull` (streamed) | `admin.py:421-425` | `PULL_TIMEOUT` connect 5s, read unlimited (`admin.py:61`) |

- `PROBE_TIMEOUT` (`admin.py:67`) is defined and never used. The probe goes through the adapter, so it gets the 300s read timeout.

**Memory bypasses the gateway.** `MEMORY_EMBED_URL` defaults to `http://ollama:11434` (`services/memory/app/embedding.py:75,283`). The model is `MEMORY_EMBED_MODEL=nomic-embed-text` (`:83,284`). It calls `POST /api/embed` with `keep_alive` 90 min (`:118,479`). Compose does not set `MEMORY_EMBED_URL` (`deploy/docker-compose.yml:100-102`), so memory depends on the hostname `ollama` resolving.

**Core never calls ollama.** Its code says so (`services/core/app/checks/stack.py:45-50`). Everything goes through the gateway: `/admin/vram` (`checks/inference.py:63-66`, `tools/inference.py:36`, `resources_api.py:35`), `/admin/catalog`, `/admin/pull` (`tools/models.py:120,616`), and `/admin/backend` (`proxies.py:241,256`).

**keep_alive:** memory's embeddings set it. The gateway chat path never does (grep finds nothing in `services/gateway`), so chat models use ollama's default 5 minutes.

### 4. GPU and VRAM facts assume the gateway runs on the GPU box
- `devices_vram.read_vram()` runs `nvidia-smi` as a subprocess inside the gateway container (`services/gateway/app/devices_vram.py:141-166`). That is why the GPU override gives the gateway a device reservation (`docker-compose.gpu.yml:33-56`).
- Per-model VRAM comes from ollama's `/api/ps` `size_vram` (`admin.py:465-499`). That call works remotely.
- `free_gb_after_switch` combines the two (`admin.py:141-185`).
- The model tier comes from live `total_gb` (from `nvidia-smi`), falling back to `hardware.json` (`suggest.py:148`, `admin.py:280-301`).
- The pull preflight checks free disk with `statvfs("/models")`, which is the gateway's `v4_models` volume, not ollama's `v4_ollama` (`admin.py:56-57,341-343`; `docker-compose.yml:84` vs `:219`).
- The `/admin/machine` RAM, CPU and disk figures are the gateway host's `/proc` (`machine.py:26-29`).
- On a mini-PC hub, all of these would describe the hub, not the Dell. VRAM would degrade to "unknown", and `compute_fit` would return `unknown` (`fit.py:118`).

### 5. What happens when ollama is unreachable
- **Routing (roles):** `installed_sizes` reads the builtin row's `/api/tags` (`routing.py:277-297`). The result is cached 30s (`:71-72`), but only on success. On failure it returns `None` uncached (`:293-294`), so every routed turn waits up to the 10s `MODELS_TIMEOUT` again.
  - Local links get the verdict `unreachable`, "ollama could not be asked what is installed" (`routing.py:349-354`).
  - The chain then moves to the next link, and the fallback reason is stated (`:446-458`).
  - If the chain has no local link, it uses the builtin standby, which also needs tags (`:358-389,459-483`). Otherwise the result is 503 `NothingRunnable` (`data_plane.py:97-101`).
- **A refusal during the call:** a connect failure raises `ProviderRefused(502, "could not reach …")` (`adapters/openai_chat.py:488-497`). `serve_by_role` then calls `record_refusal` and skips that link, with up to 6 attempts (`data_plane.py:85-129`).
  - A 5xx walls only that model, for 60s, then 5 min, then 30 min (`routing.py:63-67,212-216`). 401/402/403/429 wall the whole provider for 1h, 6h, then 24h (`:59-62`).
  - `note_success` clears walls only for non-local rows (`data_plane.py:130-131`). Local walls just expire.
  - A read timeout mid-stream becomes an SSE error chunk (`openai_chat.py:547-550`).
- **Requests without a role:** no fallback at all (`data_plane.py:51-69`).
- **Catalogue:** the local section returns a failed `{"key":"ollama","ok":false,note}` source (`catalog.py:339-346`). Core's `stack_ollama` check turns that into the finding `peer_down:ollama` (`checks/stack.py:218-240`).
- **Hidden blocker:** creating any provider, including a cloud one, first lists the builtin ollama's tags. If they cannot be read, the create is refused with a 502 (`admin.py:659-672,711`). While the Dell is asleep, you could not add a cloud provider.
- **Memory:** the semantic half of recall is switched off with a stated reason. The query budget is about 1.5s (`embedding.py:201`); the backfill budget is 30s per call (`:137`), retried every 60s up to 20 times (`:246-247`).

### 6. More than one local endpoint, a separate inference host, WoL: none exist
- There is exactly one ollama endpoint, by design: one env var and one builtin row, and everything hardcodes `get_row(pool, "ollama")` (`routing.py:291,367`; `catalog.py:340`; `admin.py:665,1141`).
- The catalogue ids are hardcoded `ollama:{name}` (`catalog.py:89,171`). The tags cache has a single key, `"tags"` (`routing.py:287`).
- No v4 code has an inference host that is separate from the stack host, a MAC address, or wake logic. Git grep for `wake.?on.?lan|magic.?packet|wakeonlan` finds only the plan `docs/plans/machine-management.md:84-89,112`. That plan dates from v3, is unbuilt, and describes WoL as a "typed tool".

### 7. What would need to change for local inference on a LAN machine
1. **Address source:** make the builtin row's URL a runtime value: store `base_url` for the builtin row, or add a new settings table, with `OLLAMA_URL` as the fallback. Places: `providers.py:82-92`, `backends.py:74-79`, `admin.py:745-749` (allow editing the URL only, then verify via `/api/version`), and `providers.py:128-133` (or permit multiple `ollama`-adapter rows with `local=true`).
2. **Multiple local endpoints**, needed if the hub also runs local inference: parametrise the builtin lookups (`routing.py:277-304,358-389`; `catalog.py:339-346`; `admin.py:665,1141`), key the tags cache per provider (`routing.py:72,287`), and rework `local_row` ids (`catalog.py:89`) and `judge_link`'s tags lookup (`routing.py:345-354`).
3. **VRAM and GPU facts:** `nvidia-smi` must run on the Dell. Options are a small agent on the Dell, or leaning on `/api/ps` only. Places: `devices_vram.py:141-166`, `admin.py:141-227`, `docker-compose.gpu.yml:50-56`, and install hardware detection (`install.sh:641-671`). Free disk for pulls must come from the Dell (`admin.py:341-343`). `/admin/machine` needs to say which host it describes (`machine.py`).
4. **Pull, remove and probe gating:** stop tying these to "default kind == ollama" (`admin.py:389-396,551-557`; `backends.py:30-38`).
5. **Memory embeddings:** set `MEMORY_EMBED_URL` in compose (`docker-compose.yml:100-102`). The owner must decide whether embeddings run on the hub's CPU (always on) or the Dell. The 90-minute `keep_alive` (`embedding.py:118`) and the hourly beat would keep asking the Dell for embeddings, which may keep it awake or fail semantic recall while it sleeps.
6. **Sleep-aware reachability:** cache the "unreachable" result for `/api/tags` (`routing.py:293-294`), and shorten connect timeouts to a sleeping host (`adapters/base.py:14-15`). Remove the ollama dependency from provider creation (`admin.py:659-672`). Add a state that says "asleep, waking" instead of "unreachable" (`routing.py:349-354`).
7. **WoL:** nothing exists. Needs a MAC and broadcast address stored on the provider or host row, a magic-packet sender, a wait-until-`/api/version` loop hooked into `routing.resolve` before the local verdict (`routing.py:434-446`), and a typed core tool for waking plus walking the user through setup. There is no `wake_*` tool today; the tool list includes `inference_health` and `route_explain` (`tools/inference.py:161`, `tools/route.py:92`).
8. **Deploy and onboarding:** add a hub profile that leaves out the `inference` profile and the GPU override (`docker-compose.yml:215`, `install.sh:246-251`). Add a "Local, on another machine" engine to `ChooseEngine.tsx:14-34`. That engine keeps `local=true` and the catalogue, unlike today's `remote` kind (`backends.py:118-136`).