## Prior art: hub / remote GPU / Wake-on-LAN in earlier Novas

### Lineage map (needed to read the history)
- **Platform line (v1)**, tags v0.1.0-alpha to v0.5.0-alpha: `llm-gateway/`, `recovery-service/`, `orchestrator/`, `dashboard/`.
- **June "agent-core" rewrite** (PRs #14-#30, then called "v3"). This line had the full WoL feature and the endpoint pool. Merge `62b6c2ad` (2026-07-06) threw the whole line away with `-s ours`: "no files from the v3 line are carried over". It is still reachable in history (e.g. `c98e2952`, `366f9c49`).
- **Current root v3** (`backend/`, `frontend/`, `inference-control/`), tags v0.6.0 and v2.0.0-alpha. It started from scratch at `10d8c642` (2026-07-13), which deleted `wol-helper/` and `llm-gateway/app/wol.py`.
- **v4** (`services/`, `apps/`, `deploy/`): WoL, a remote inference host, hub, thin-client and satellite code all **do not exist**. The only mention is a plan: `docs/plans/machine-management.md:84-89,112`.

### 1. v3 `inference-control/`: what it was
- `inference-control/Dockerfile:1-9`: python:3.12-alpine plus the docker CLI and compose, port 9911.
- `inference-control/server.py:1-22`: "the only holder of the Docker socket". It exposes a fixed verb list on the compose network, and nothing in a request becomes a parameter. Compose file, project and service are hard-coded (`:40-74`).
- **Original job** (`4cbeaaac`, 2026-07-14, "~120-line" sidecar): start and stop the bundled `ollama` compose service from Settings (`_run_op` `:1267-1286`; `POST /start|/stop` `:1710-1711`).
- **GPU auto-overlay** (`ff9a49a3`): it merges `docker-compose.gpu.yml` when docker reports the `nvidia` runtime (`OLLAMA_GPU=auto|on|off`, `:45-47,148-156,212-213`). Measured effect: 6.0 → 138.5 tok/s.
- **Measurement verbs**:
  - `/gpu`: runtime check (`:269-279`).
  - `/vram` and `/gpu-stats`: run `nvidia-smi` **inside the local ollama container** (`:282-339`).
  - `/containers`, `/disk`, `/logs`, `/reachable` (`:413-818,1232-1264`).
- **Model-store relocation** (`/relocate`, `:113-135,1501-1583`). The backend writes `/state/models_dir`, which the sidecar mounts read-only. Copying is non-destructive.
- **Scope creep** to 1,811 lines: ntfy up/down/expose (`:1353-1417`), Home Assistant (`:1420-1498`), `/service/redeploy` with a detached verdict (`:530-690,1717-1754`), and a `/sandbox/check` gate (`:821-1225`).
- **Auth added late** (`9b96f97e`, `:76-111`). A bearer token exists, but an unset token **accepts** requests. That was a deliberate exception.

Lessons its comments record:
- Pass `--project-directory` as the host path, or relative binds resolve inside the sidecar (`:194-216`).
- Pass `--env-file`, or every `${VAR}` silently goes blank (`:171-191`).
- Never recreate tailscale from here; a recreate once wiped its serve config and auth (`:1370-1375`).
- Use `up -d`, never `restart`, which does not re-read `.env` (`:551-552`).
- Don't let it redeploy itself (`:558-569`).

**Relevance:** it was built for one box. Every GPU fact comes from `docker exec` into the *local* container. `backend/app/local_context.py:197-228` sizes `num_ctx` from `/gpu-stats`, so on a hub with a remote GPU it returns `None` and cannot size anything.

### 2. Wake-on-LAN: three attempts, none alive today
**A. Platform line (March 2026, `0c5cfd14`, still in v0.5.0-alpha)**
- `llm-gateway/app/wol.py:1-48`: stdlib magic packet sent by UDP broadcast **from the gateway container** (bridge network).
- The MAC and broadcast address come from Redis config keys `llm.wol_mac` / `llm.wol_broadcast` (`orchestrator/app/migrations/009_llm_routing.sql:1-10`, `llm-gateway/app/registry.py:386-393`), or env `WOL_MAC_ADDRESS` (`.env.example:58-60`).
- The trigger is in `providers/ollama_provider.py:177-219`. The health gate fails, the packet is sent in the background (at most once per `wol_boot_wait_seconds=90`, `config.py:43`), and the call **raises immediately**.
- Good distinction: the cheap status `probe()` "never fires WoL" (`:164`).
- UI/code mismatch: the UI says "send Wake-on-LAN … **before retrying**" (`dashboard/.../LocalInferenceSection.tsx:626`), but nothing retries.

**B. June agent-core line: the most complete version (`adbcf38f`, `69e47ae9`, `366f9c49`)**
- `llm-gateway/app/wol.py` (at 366f9c49), lines 3-8, says it outright: "Containers on Docker's bridge network usually can't emit [L2 broadcast]".
- It therefore added a **`wol-helper` sidecar** with `network_mode: host`, compose profile `wol`, and admin-secret auth (`wol-helper/app.py:1-75`, compose block in `adbcf38f`).
- The MAC lives in the secrets vault as `wol_mac`. No secret means the feature is off (`wol.py:10-11,27`).
- Auto-wake: a local candidate that fails with a connection error fires a wake, rate-limited to one per 5 min per endpoint (`wol.py:86-108`; `router.py:196-212`).
  - The turn still returns **503 "sent Wake-on-LAN … retry in a minute or two"** (`router.py:206`). Local-first falls through to cloud.
  - There is no queue and no wait-for-ready.
- Manual `POST /hardware/wake`, 409 when unconfigured (`router.py:435-451`).
- Models-page "inference host unreachable" banner with a Wake button, plus guided setup: MAC validation, "Send test packet", Remove (`69e47ae9`).
- Bug found along the way: `secrets_client` cached secrets for the process lifetime, so a changed MAC was invisible until restart. Fixed with a 5-min TTL.
- Gotcha recorded at `wol.py:31-34`: a monotonic clock near 0 at boot silently rate-limits the first wake.
- **Endpoint pool** (`llm-gateway/app/endpoints.py` at 366f9c49):
  - Named endpoints `{engine, url, lifecycle: always-on|wake-on-lan|on-demand, wol_mac_secret, enabled}` (`:8-9,23-24,47-82`).
  - Routing fans out in file order (`:119-124`); `by_api_base` maps a failure back to its endpoint for the wake (`:127-133`).
- **Verification was loopback only.** A 102-byte packet was captured by a UDP listener, and Playwright clicked the button (commit message of `adbcf38f`). No real sleeping host was ever woken. The dev box *was* the Dell.
- **Fate:** discarded by `62b6c2ad`, never ported.

**C. Current v3 (`backend/`)**: no WoL at all. The only thing in the repo is the spec for "WoL + network reads as typed tools" and a `machine-control` sidecar (`docs/plans/machine-management.md:82-112`). It was never built: no migration 117, no sidecar.

### 3. Hub / split topology designs (all design-only)
- `docs/superpowers/specs/2026-03-28-distributed-deployment-design.md`, via `git show v0.5.0-alpha:…`:
  - "Option 3: Distributed Home Lab": an always-on mini PC runs the gateway and brain tiers, and the GPU box runs inference "on-demand via WoL" (`:73-94`).
  - Health-aware routing: probe every 30 s, and on UNREACHABLE+WoL "send a wake packet and queue the request" (`:437-471`).
  - Explicitly **unresolved**: "which service sends the magic packet, wake-to-ready latency, timeout before cloud fallback, request queuing" (`:473,977`). Status: "DESIGN ONLY" (`:3`).
- `docs/roadmap-archive-2026-03.md` at v0.5.0-alpha:
  - `:1644-1666`: "Mini-PC Nova → Cloud APIs + WoL → Dell Ollama", with per-device routing.
  - `:1808-1850`: a Devices page with Online/Sleeping/Offline, a Wake button, and a `devices` table with `wol_mac`. None of it was built.
- `366f9c49:docs/specs/2026-06-10-recommended-models-design.md:142-183`: "gated by the **inference host's** hardware, never the gateway's". The host profile is detected, **declared** for remote hosts (`PUT /hardware`), or observed via `/api/ps`. The unreachable banner is "the hook point for Wake-on-LAN".
- `19689fbc` (2026-05-06): "Beelink was never a Nova host". Mini-PC references were stripped from the docs.
- **Thin clients:** the standing answer was "one instance + tailnet PWA from every device" (`docs/plans/remote-shared-state.md:6-8`). The same plan built a real Postgres advisory-lock leader election for multiple instances (`backend/app/leader.py`, plan `:36-76`). "Local inference … stays per-instance" (`:52-58`).
- `docs/archive/NEXT-v3.md:102-105`: `NOVA_SECRET_KEY` must be set "before the Dell or the mini PC joins".
- Memory `capability-acquisition-arc.md:129-149`: Jeremy (2026-07-29) wants "ollama … only on my dell … most other services on my mini pc". The idea was k3s on the mini PC, with GPU pinning as a node label.

### 4. Bundled vs external inference: the reversal
- `093873b` (2026-07-01) removed bundled inference: "BYO-external only".
- `df576c9` (2026-07-03) reversed it: bundled compose profiles plus the GPU overlay, and external servers still work.
- Memory `inference-byo-external.md:10-24`: "Nova is HYBRID by design — don't 'clean up' either half".
- The v0.5.0 backend pool (`llm-gateway/app/pool.py:1-27`) has `kind: container|remote`, engine and url, and the Redis key `inference.backends`.
- v3 is left with a single scalar `inference.ollama_url` (`backend/app/settings_store.py:96-101`).

### 5. Keep-alive and idle unloading
- Nothing in any lineage **suspends or idle-shuts a host**. There is no powercfg, suspend or wake-to-ready code at v0.5.0, `c98e2952`, v2.0.0-alpha or HEAD. The only power lever ever used is model eviction:
  - `keep_alive: 0` in `backend/app/model_tournament.py:521-523`, and in the platform line's `llm-gateway/app/discovery.py:861-866`.
- v3 `backend/app/model_warmer.py:1-10,25,84` pins main's model with `keep_alive=-1` every 60 s (off by default, `settings_store.py:227`).
- v4 memory embedder: `DEFAULT_URL="http://ollama:11434"` (`services/memory/app/embedding.py:75`), keep-alive 90 min (`:118`). The hourly review check is what keeps it warm (`services/core/app/checks/review.py:326-331`).

### 6. Memory files (all five exist)
- `inference-byo-external.md`: the reversal record above.
- `ollama-container-shadows-host.md`:
  - `:10-16`: the bundled container on `127.0.0.1:11434` shadows the Windows host's Ollama. A host Ollama needs `OLLAMA_HOST=0.0.0.0` plus a firewall rule.
  - `:18`: the bundled Ollama booted with **zero models**, so every call returned 502. The fallback chain then sent the *local model name* to cloud providers (all 400).
  - `:22`: timeouts tuned for cloud killed local generations mid-stream.
- `local-model-context-vram-trap.md:19-32`: a slow turn was a Windows game on the GPU. WSL2's `nvidia-smi` cannot attribute Windows-side VRAM.
- `tournament-vram-self-starvation.md:16-40`: Ollama keeps models resident, so back-to-back loads starve each other. Fixed by `keep_alive: 0` eviction.
- `compose-gpu-overlay-trap.md:8-27`: in v4, a bare `-f deploy/docker-compose.yml` ran Ollama on CPU and turns hung for 300 s. The overlay must be merged; use absolute `COMPOSE_FILE`.
- Also relevant: `ollama-context-cap-findings.md:80-98`. Every distinct `num_ctx` means a full reload (4.6-271 s), so a freshly woken box is slow.

### Lessons for the new design
1. **Send the magic packet from the host network namespace on the Dell's L2 segment** (lesson from 2B). A bridge-network container can't (`wol.py:3-8`). On the Linux mini PC a host-network helper works. On WSL2 the June `network_mode: host` helper was never shown to reach a real LAN.
2. **Status probes must never wake the box** (`ollama_provider.py:164` vs `:209-217`). Nor may keep-warm pins or a remote embedder (`model_warmer.py`; `embedding.py:75,118`). Otherwise the Dell never sleeps, and recall degrades whenever it does. Keep the embedder on the hub.
3. **Wake-to-ready was never designed** (spec `:473,977`). Both implementations failed the turn and said "retry". Build wake → poll readiness → load the model, with a deadline, visible progress, and cloud fallback. Don't repeat the UI-says-retry, code-doesn't mismatch (`LocalInferenceSection.tsx:626`).
4. **Model the endpoint explicitly.** Reuse the `endpoints.py` shape: per-endpoint `lifecycle` (always-on / wake-on-lan), per-endpoint MAC secret and rate limit. Hub-local vs remote is the old `kind: container|remote`.
5. **Hardware facts belong to the inference host** (recommended-models spec `:147-173`). v3's VRAM path is local-only, so the Dell needs its own reporter or a declared profile.
6. **Windows/WSL2 GPU-box traps:**
   - bind to `0.0.0.0` and add a firewall rule;
   - port 11434 collision between a bundled container and a host Ollama;
   - Windows GPU use is invisible to WSL2's `nvidia-smi`;
   - the GPU overlay must be merged;
   - after a wake, confirm the model is actually present;
   - fallback must substitute a cloud model name, not forward the local one.
7. **Keep the socket-holder pattern tight.** A fixed verb list plus a token that is refused-when-unset from the first commit (`machine-management.md:105-110`). v3's sidecar started at about 120 lines and ended at 1,811.
8. **For Nova walking the user through setup, the typed tool already exists as a spec.** Build WoL and network reads as typed tools, with an operator-write-only `machines` registry (`machine-management.md:74-89`). Flip the `capability_claims` "machine access" satisfiers in the same change that gives her the tool (`:129-133`).
9. **No earlier Nova managed power beyond model eviction.** GPU-box sleep policy is new ground.