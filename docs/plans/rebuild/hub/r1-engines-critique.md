# Adversarial review: per-machine engines in the gateway and the inference-node package

I checked every claim below against the worktree, read-only. Numbered findings are ranked by severity.

## Findings

### Critical

**1. Background roles cannot avoid the node. Under the core interface the design requires, beats would wake the Dell every hour.**
- **Defect.** `routing.resolve` puts `requested` at link 1 for every role (`services/gateway/app/routing.py:413-415`). Background work sends `chat.model` as `requested`:
  - beats and plain scheduled firings (`scheduler.py:259-266`, run through `chat._run_turn`, so through `_gateway_round`);
  - the review check and distil (`checks/review.py:474-486`, `distil.py:771-781`, via `model_read.chat_model`), sent with role `beat` (`model_read.py:216-227`).
- **What happens after handover.** `chat.model` becomes `dell:qwen3.8:27b`, so every beat, review, distil and scheduled firing has dell at link 1.
  - The design returns 409 to every caller ("A request with no role gets the same 409").
  - Its core interface #1 handles the 409 inside `_gateway_round`, which beats also use. So beats wake the Dell hourly and it never stays asleep, which defeats decisions 1 and 2.
  - Callers that do not handle the 409 fail outright instead of using the next link: `_collect_completion` (`chat.py:2957`), `model_read.complete` (`:292`), and the eval warm-up (`evals/runner.py:1531`).
  - DoD step 8 cannot pass.
- **Fix: make waiting opt-in (D1).** An asleep engine gets a 409 only when the request says it will wait (`X-Nova-Wake: wait`, sent by core only for interactive chat and eval turns). Every other caller gets an `asleep` verdict (not runnable, stated reason) and the walk moves to the next link.

**2. A Windows machine woken by LAN goes back to sleep after about 2 minutes unless a power request is held. The hold design is too slow and nothing measures this.**
- **Defect.** Windows applies its "unattended sleep timeout" (default 120 s) when it wakes with no user input. This is platform knowledge, not something the repo shows, so it must be measured. Network traffic does not reset that timer.
- **Why the design's hold is too slow.** It hangs on novad inside WSL:
  - envelope TTL is 60 s (`envelopes.py:54`);
  - a single device command is capped at 110 s (`client.go:32`);
  - reconnect backoff reaches 30 s (`client.go:119`);
  - core must then poll `/admin/engines` or `/node/activity` to feed it. The design leaves "either/or" undecided, and core reading `/node/activity` directly bypasses the gateway.
- **Why it matters.** Turns of 100-400 s are documented (`devices_vram.py:55-59`). A woken answer longer than about 2 minutes dies mid-stream. The gateway then waits out the 300 s read timeout before sending an error chunk.
- **Gaps in the measurements.** M1-M12 have no item for this. After an overnight sleep the WSL clock can lag, and novad's 120 s skew rule could then reject hold envelopes.
- **Fix (D10).** Measure it as M13. Make the hold part of the node package, driven by the node's own activity under a lease.

### Major

**3. `engines.compute` is stored in the database, and the database moves with the migration.**
- The design rejects `.env` for compute because ".env moves with the migration, so an id stored there would move with it and lie". All three databases move too (decision 5).
- After import on the mini PC, the builtin row still holds `compute='gpu:GPU-…'`, the 3090. Its `last_tags` and `last_facts` still describe the Dell.
- The design never says whether `X-Nova-Served-On`, the probe stamp (`/admin/probe stamps provider and compute`) and `served_on` read that column or a live reading. If they read the column, N150 measurements are labelled as 3090 ones, which is exactly the forbidden change of meaning.
- Fix: D5.

**4. Through the tailnet proxy, "connect" timeouts do not bound reaching the peer, and the design's error classification misses the real errors.**
- httpcore sends the CONNECT with the request's own timeout extensions (`httpcore/_async/http_proxy.py`, the `connect_request` built with `extensions=request.extensions`). The CONNECT reply is therefore read under the **read** timeout. `connect` only bounds the TCP connect to the local proxy and the TLS handshake.
- Consequences:
  - `ENGINE_PROBE_TIMEOUT`'s `connect=1.5` really means up to 5 s.
  - `ENGINE_COMPLETIONS_TIMEOUT` (`read=300`) against a node that slept after a cached "ready" (the cache lasts 30 s) can hang for 300 s.
  - Failures arrive as `httpx.ProxyError` or `ReadTimeout`, not `ConnectError`. They escape the "connect-phase" `ProviderUnreachable`, become a 502, and are walled (`data_plane.py:112-118`).
- The 409's evidence string, "no answer within 1.5 s", is a constant, not a measurement.
- On a cold DERP path, which is plausible with ProtonVPN up, an awake Dell can take longer than 1.5 s to answer. It would then be judged asleep and sent a pointless wake.
- Fix: D3.

**5. After one missed wake, the Dell is never woken again.**
- In the state table, "last wake missed and no ready since" leads to `unreachable`, which is not runnable and produces no 409. Nothing clears it except the Dell becoming ready some other way.
- One WoWLAN miss (M1 is exactly what makes a miss likely) becomes a permanent cloud fallback, or a permanent 503 when the chain has no other link.
- That is the gateway deciding, which breaks "state, never decide".
- Fix: D2.

**6. The wake ledger cannot honestly report whether a wake landed (decision 7).**
- **A row is written whether or not a packet went out.** `via` is "what core says sent it", and nothing orders the row after the relay confirms the send. An offline or unpaired relay produces a `missed` row, which counts against Wi-Fi wake.
- **`landed` means any ready reading after an open wake.** An awake Dell behind a slow path (finding 4), or a human pressing a key, is recorded as a wake that landed in about 1 s.
- **A late ready is recorded as a miss.** The check `outcome='missed' AND ready_at IS NULL` forbids recording one: a Dell that is ready at 150 s against a 90 s deadline is logged as "did not land". The lazy close to `missed` runs before the ready reading.
- Fix: D6.

**7. Background paths still touch sleeping engines, and `route/explain` would return a 500.**
- These tools run on their own (`AUTO_RUN`, `live_facts.py:81-111`): `route_explain`, `model_check_update`, `model_catalog_search`, `inference_health`.
- The routes they reach:
  - `/admin/route/explain` calls `routing.explain`, which calls `resolve` (`routing.py:487-508`). The design has `resolve` observe engines and raise `EngineAsleep`; `explain` does not catch it, so the route returns a 500.
  - `/admin/catalog/drift` (a live `/api/show` on the node).
  - `/admin/catalog` (`_fit_context` plus a section per engine).
- The design only promises that beats never pass `live=1`. Under M2, any of these reads could itself wake the Dell.
- Fix: D11.

**8. Readiness mixes speed with readiness.**
- The rule "every resident model has `size_vram ≥ size`" makes the node not ready whenever any model is partly offloaded to CPU. The documented game-on-the-card incidents are one cause (`devices_vram.py:14-20,55-59`); an unrelated resident model is another.
- Core then polls `/ready` until the deadline and falls back, even though the Dell is up and serving.
- This contradicts open question 2, which describes `cpu_only` as "serves slowly and says so".
- Fix: D4.

**9. Model capabilities are lost for a sleeping engine, which leads to a false "nothing here can see images".**
- `last_tags` holds the tag list only. Capabilities come from `/api/show`, cached in-process by digest (`adapters/ollama.py:69`), and are lost on a gateway restart.
- Core's `vision.capable` skips rows with no capability map (`vision.py:57-77`). `choose` then states, as certain, "No model installed on this machine reports the vision capability" (`:164`), while a vision model sits on the sleeping Dell.
- `standby`'s embedding skip reads the same cache.
- Fix: D7.

**10. Most calls to the node would go out without its token.**
- `Ollama.headers` returns `{}` (`ollama.py:303-304`).
- These calls build `http_client` with no headers at all:
  - `list_models` (`:310`) and `verify` (`:332`);
  - `show` (`:112`) and `delete` (`:139`), and through `show`, `facts_for_installed`;
  - `admin._resident_models` (`admin.py:121`);
  - the pull client (`admin.py:421`).
- The design only fixes `completions` and `probe`. Every other call would get a 401, and the state table would misreport it as "the node refused this hub's token".
- Fix: D8.

**11. A pull hangs forever if the node sleeps or the path drops.**
- `PULL_TIMEOUT` has `read=None` (`admin.py:61`). Through the tailnet proxy, a vanished peer never errors, so the relay never ends.
- `_PULLS_IN_FLIGHT` (`admin.py:310`, released in the relay's `finally`, `:451-454`) is then never cleared. Every later pull of that model is refused as "in flight since…" until the gateway restarts.
- Fix: D12.

**12. Enrollment from the node needs a tailnet path the design never gives it.**
- The node sidecar only serves inbound traffic. `app.enroll` has to reach `https://nova.<tailnet>.ts.net`, and the hub's web is loopback-only (`docker-compose.yml:119`).
- On a Linux node without host Tailscale this fails. That contradicts the design's own rule that it "does not depend on host Tailscale".
- It works on the Dell only because Windows Tailscale happens to be running.
- Fix: D9.

**13. The Dell runs Docker Desktop, not dockerd inside WSL.**
- The WSL docker binary is `/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker`.
- So "native Linux and WSL2 mirrored behave the same", and the plan for `keepalive.ps1` to "keep WSL up", aim at the wrong VM. The containers run in the docker-desktop VM:
  - it starts only when a user signs in, so after a Windows Update reboot the node stays down until someone logs in;
  - it resumes with its own clock and GPU state.
- M5 should measure this instead.
- Fix: D9 and D17.

**14. The guards break house rules or contradict true statements.**
- **(a) A hardcoded name.** The capability phrase contains the literal "dell", which breaks "derived, never hardcoded".
- **(b) `stack_claim` fires on true fallback statements.** Adding `asleep|sleeping` to `_SERVING_STATE` (`guards.py:4652`) plus "scope to other engines" still fires on true fallback sentences built on generic nouns, for example "the local model is asleep, so Claude answered". `served_this_turn` is true (`guards.py:4687-4702`), and a generic noun names no engine.
- **(c) Unchecked readings count as evidence.** The design never says that an `engine_state` fact with `live:false` or `unobserved` must not back a present-tense claim.
- Fix: D14.

**15. The move and handover miss several model references.**
- `chat.vision_model` (`settings_store.py:105`, read at `chat.py:3829`) is not rewritten.
- A bare `chat.model` resolves to the default provider, which after the move is the N150.
- Core's `model_pull._target_of` strips only `ollama:` (`tools/models.py:446`).
- The gateway's `pulls.MODEL_RE` allows only one colon (`pulls.py:28`), so `dell:qwen3:8b` and `library:x:y` fail `validate_model` unless the engine prefix is split off first.
- The web onboarding pull (`Downloading.tsx`) sends bare ids, which the design will reject with a 400 once there are two engines.
- Fix: D15.

**16. DoD step 4 ("Nova re-probes dell:…") names a capability she does not have.**
- No registered tool calls `/admin/probe`. Only the web does, via `proxies.py:234-236`.
- `tools/models.py:52` also labels a probe "a probe on this GPU", which is wrong on a hub with no GPU.
- Fix: D16.

**17. `POST /admin/engines` skips the name-shadow check.**
- An engine named like a model family (for example `qwen3`) changes the meaning of bare ids (`admin.py:659-681` runs only for `/admin/providers`).
- `library` is reserved only by an SQL check. `validate_name` does not reserve it, so a clash surfaces as a CheckViolation and a 500.

### Minor

18. **`*.ts.net` is hardcoded** in both the validation and the proxy choice. Headscale or custom-domain tailnets would be refused. Derive it from the node's own reported `DNSName` and a per-row flag.
19. **"Cannot be CHECKs" is false** for the rules that only touch providers (engine means `adapter='ollama' AND NOT builtin` on the same table), so they can be a CHECK.
20. **The 409 body's `next` may observe later links.** With N nodes that could wake another machine. Judge later links from cache only.
21. **`POST …/wakes` carries a `mac`** although the gateway already holds it, so two sources can disagree.
22. **Cut the RAM frame (YAGNI).** `_resident_models` reads only `size_vram`, and `_footprint_vram_mb` returns None for 0 (`admin.py:495-498`), so CPU probes never record anything. Also cut `nics` and `wake_mac_source='node'`: a container inside Docker Desktop cannot see the Windows network adapters.
23. **`/load` must send exactly the options the chat path sends.** Today neither sets `num_ctx`. Pin this with a test, or `/load` becomes a lie followed by a second full reload.
24. **The eval prompts say "the dell"**, which depends on this owner's setup. Also, the tool and eval counts (39→42, 23→25) must be computed once across all three areas.
25. **`${VAR:?run ./install}` breaks the e2e runs.** `tests/e2e/isolated.sh` and the e2e overlays run `-f deploy/docker-compose.yml` without the new variables.
26. **Adopting `nova_v4_ollama` in place is risky.** The old `nova` project on the Dell still declares that volume, so a later `down -v` deletes the node's model store. Copy it into `nova-node_ollama` instead.
27. **`engine_wakes` cascades on provider delete.** Re-enrolling under the same name erases the measurement history. Use no FK.
28. **Probe latency and tok/s now include the tailnet path.** Record local or tailnet on the row, or say so in the docs. Keying the speed baseline by bare model plus `served_on` would carry the 3090 baseline from `ollama:` over to `dell:`.
29. **Handover leaves `ollama:X` links pointing at the N150** when X is not on dell. The intent was "the GPU box": rewrite them to `dell:X`, which then reads `not_installed`.
30. **The outbound proxy can be reached from every container on the compose network.** Add a compose test that nothing but the gateway gets `NOVA_TAILNET_PROXY`. Add `test_secrets_not_logged` cases for the enroll and create paths.

## What survives unchanged

- **Engines as rows.** A providers row with `adapter='ollama'` plus a 1:1 `engines` row, and provider-qualified ids using the first-colon split. `local` stays derived from the adapter.
- **Every-site table.** The table of single-engine sites is accurate apart from the additions in findings 7, 10, 15 and 17.
- **Caching.** Per-engine caches, including cached failures, replace the single `"tags"` key.
- **Typed 409 and headers.** The typed `engine_asleep` refusal below 500 (so it is never walled), `X-Nova-Skip-Engines`, and `X-Nova-Served-By` / `X-Nova-Served-On`. What changes is who receives the 409 (D1).
- **Compute as measurement identity** (`gpu:<uuid>` or `cpu:<model>|<n>c|<GiB>g`), with legacy rows never read, following migration 008. What changes is how it is stored (D5).
- **Shadow check.** Limiting it to the default provider is right, and it removes the "cannot add a cloud provider while the Dell sleeps" blocker.
- **Standby, disk, embeddings.** Standby skips embedding models. Pull free-disk comes from the engine's own volume. `MEMORY_EMBED_URL` is pinned to the hub's ollama.
- **Node package.** A bearer-token reverse proxy with a fixed verb list that refuses everything until enrolled, a userspace tailnet sidecar serving 443, no LAN bind, no Windows port forwarding. The hub reaches `*.ts.net` through `TS_OUTBOUND_HTTP_PROXY_LISTEN` without needing host Tailscale.
- **`choose_subnet`**, shared by hub and node, keeps an existing project network.
- **Migration number.** `009_engines.sql` is correct: the highest existing is 008, and 009 must stay idempotent.
- **Tool shapes.** `engine_status` (NOT_AUTO_RUN), `engine_add_code`, and `engine_configure` with read-back.
- **The answer to question 8.** No SSH keys and no secrets manager: tailnet WireGuard plus a per-link bearer minted on the node and handed over during enrollment. It is stored like every other provider key until Proposal A.
- **M1-M12.** Keep them all and add D17.

## Corrected design deltas

**D1. Waiting for a wake is opt-in.**
- Add the header `X-Nova-Wake: wait` and `routing.resolve(..., may_wait: bool)`.
- When the first link that would serve is on an engine in state `asleep|waking`:
  - with `may_wait`, raise `EngineAsleep` (the 409);
  - otherwise give the verdict `asleep` (not runnable) with a reason such as "dell asleep (not woken: this call does not wait); last ready 01:58", and continue the walk. The reason is carried in `X-Nova-Route` and the ledger.
- Core sets the header only in `_gateway_round` when the purpose is `chat` or eval. The eval warm-up sets it too and handles the 409.
- For callers that do not wait, wake-on-LAN engines are judged from cache only, unless M2 proves a TCP read cannot wake the node. Record that as a constant that cites the measurement.
- Test: role `beat`, requested `dell:x`, the chat chain has `openrouter:y`, the Dell is cached asleep. Expect openrouter to serve, the route reason to name dell, **zero** calls on the mounted node transport, and no `engine_wakes` row.
- Do **not** change how `requested` becomes link 1 (`routing.py:413`).

**D2. States.**
- `unreachable` covers only: `always_on` plus a connect failure, a 401, and "agent answers but ollama does not".
- A wakeable engine that does not answer is always `asleep`, with `last_wake {outcome, sent_at}` in the 409 body and in `engine_status`. Core decides whether to retry.

**D3. Timeouts and classification for engine calls.**
- Build every client through D8.
- Wrap each observation in `asyncio.timeout(ENGINE_REACH_S)` as a total deadline.
- On a wait-opted request, the route observes wake-on-LAN engines **uncached**: one `/node/ready?model=` round trip immediately before serving.
- Bound the completion's time-to-headers by `ENGINE_REACH_S` when that same observation showed the model resident, and by `ENGINE_LOAD_S` otherwise.
- `ProviderUnreachable` covers `ConnectError`, `ConnectTimeout`, `ProxyError`, and `ReadTimeout` before headers when an immediate re-observation also fails. It is never walled.
- Evidence strings are the measured elapsed time plus the exception class. M7 sizes the constants.

**D4. Readiness.**
- `ready = agent ∧ ollama.ok ∧ (model∅ ∨ installed) ∧ (¬gpu.expected ∨ nvidia-smi readable)`.
- Partial offload is a stated fact (`offload:[{model,size,size_vram}]`) in the ready body and the route reason, never a readiness bit.
- `cpu_only` becomes a fact, not a state.

**D5. Compute.**
- The builtin's compute is never persisted. It is derived live per process: `/proc`, plus `nvidia-smi` read once at start and on each observation.
- On startup the gateway nulls the builtin's `compute`, `last_tags` and `last_facts`.
- For nodes, `engines.compute` is display-only ("as of").
- Every stamp (the probe row, `usage_events.served_on`, `X-Nova-Served-On`) uses the compute returned by the **same request's** live observation. If there is none, the stamp is NULL or omitted.
- Test: the database holds builtin `compute='gpu:X'` and `/proc` shows the N150. Expect `served_on='cpu:…N150…'`.

**D6. `engine_wakes`, replacing the design's version.**

```sql
CREATE TABLE IF NOT EXISTS engine_wakes (
  id bigserial PRIMARY KEY,
  engine text NOT NULL,                 -- no FK: the ledger outlives re-enrollment
  sent_at timestamptz NOT NULL,         -- from the relay's signed result
  via text NOT NULL,                    -- relay device id
  mac text NOT NULL, target text NOT NULL,  -- broadcast address or unicast IP actually used
  prior_state text NOT NULL, prior_evidence text NOT NULL,
  deadline_at timestamptz NOT NULL CHECK (deadline_at > sent_at),
  woke_at timestamptz, woke_evidence text,  -- e.g. device reconnect, powercfg lastwake source
  ready_at timestamptz,
  outcome text CHECK (outcome IN ('landed','late','missed','not_asleep')),
  CONSTRAINT engine_wakes_outcome_shape CHECK (
    outcome IS NULL
    OR (outcome = 'landed' AND ready_at <= deadline_at)
    OR (outcome = 'late' AND ready_at > deadline_at)
    OR (outcome = 'missed' AND ready_at IS NULL)
    OR outcome = 'not_asleep'));
```

- Core calls `POST …/wakes` only **after** the relay's signed result says the packet was sent. A send failure is not a wake row.
- Rows stay open until `deadline + LATE_WINDOW_S`, so a late ready is recorded as `late`, not `missed`.
- `not_asleep`: the node answered within `NOT_ASLEEP_S` of the send and its facts show no resume.
- Landing statistics count `landed / (landed + late + missed)`.
- Add to `engines`: `wake_target text` and `wake_target_source`. M1 may show that only a unicast packet to the Dell's LAN IP works over Wi-Fi.

**D7. Persisted model facts.**
- New table `engine_models(provider, name, digest, capabilities jsonb, context_length int, read_at)`, written on every `/api/show`.
- Rows served from cache carry `capabilities` from this table. With none, they carry `capabilities_known:false`, and core treats that as "could not be checked", not as "cannot".
- `standby` reads the same table.

**D8. One client builder: `engines.client(app, row, timeout)`.**
- It combines `base_url_of`, the row's bearer (`bearer_or_header(row, header_name="Authorization")`) and the proxy for tailnet hosts.
- `show`, `delete`, `list_models`, `verify`, `facts_for_installed`, `_resident_models`, pull and probe all take a row and go through it.
- The fake node in tests enforces the bearer.
- A test fails if `adapters/ollama.py` or `admin.py` builds an engine client any other way.

**D9. Node package.**
- The node sidecar also sets `TS_OUTBOUND_HTTP_PROXY_LISTEN` on its fixed address, and the enroll CLI uses it.
- The installer detects Docker Desktop (`docker info` OS) and states that the node starts only when a user signs in.
- Drop the "keep WSL up" task for the containers. novad's WSL lifetime belongs to the other area.
- Copy the adopted model volume into `nova-node_ollama` instead of mounting `nova_v4_ollama` in place.
- The node compose healthcheck uses `/node/health/live` only.
- Pass the new subnet variables through the e2e overlays and `isolated.sh`.

**D10. Holding the node awake is the node's job.**
- `./install node` installs a host helper:
  - on Windows or WSL, a scheduled task that calls `SetThreadExecutionState(ES_SYSTEM_REQUIRED|ES_CONTINUOUS)`;
  - on Linux, a `systemd-inhibit` unit.
- It holds while the node-agent's own lease is live: activity within the last `HOLD_GRACE_S`, sized by M16.
- It also holds for up to `deadline_s` after a resume when `powercfg /lastwake` names the network adapter.
- `/node/facts.hold = {installed, active, reason}` reaches `engine_status`. "No hold: it can sleep mid-answer" is stated in the 409 body.
- Remove requirement #6 (hold through novad) and the gateway `in_flight` feed.

**D11. Background reads never touch a sleeping node.**
- Everything defaults to `live=False` except:
  - a wait-opted routed completion;
  - `/ready`, `/load` and `/wakes`;
  - pull, remove, drift and probe naming a wake-on-LAN engine, which return the 409 ("cannot: dell is asleep — checking would wake it");
  - an explicit `?live=1`.
- `explain` catches `EngineAsleep` and reports it as a verdict.
- Test: a node transport that raises if touched while calling `/admin/catalog`, `/admin/route/explain`, `/admin/engines`, `/admin/suggest` and `/admin/engines/{n}` with the engine cached asleep.

**D12. Pulls to an engine use a finite read timeout.** Size it from M17, for example 120 s between lines. On timeout, write a stated error line and release `_PULLS_IN_FLIGHT`.

**D13. `engines.create` runs the shadow check**, and `validate_name` refuses `ollama` and `library`.

**D14. Guards.**
- Capability phrases use generic nouns ("(the|your) (gpu|other|inference) (machine|pc|computer|box)"), plus live engine names added at check time.
- `stack_claim_check` stands down when any `llm_call` span this turn carries `gateway_status=409` or a `route_reason` naming an asleep or skipped engine.
- `asleep` joins `_SERVING_STATE` only for subjects that name the engine that served.
- `state_claim` accepts `engine_state` facts as evidence only when `live:true`.
- Add a `MUST_FIRE` or eval case for the false fallback correction.

**D15. Move and handover.**
- Handover also rewrites `chat.vision_model`, and bare ids (read as default provider, builtin) into `dell:`. It rewrites `ollama:X` to `dell:X` even when X is not installed there.
- Split the engine prefix with `providers.split_model_id` before `pulls.validate_model` in pull, remove and drift.
- Core: `_target_of`, `vision._named`, `stack._row_for` and the web onboarding pull all move to engine-qualified ids.

**D16. Probing.** Either add a `model_probe` tool (registry +1, narration kind `probed_model`, eval), or rewrite DoD step 4 as an owner action in the UI and say so. Fix the `tools/models.py:52` label.

**D17. Measurements to add before building.**
- **M13:** the Windows unattended re-sleep time after a packet wake with no input (`powercfg /q … UNATTENDSLEEP`), with and without the helper's hold.
- **M14:** Docker Desktop after S3 resume and after an unattended reboot:
  - does the engine come up without a sign-in;
  - is the GPU visible in the node-agent.
- **M15:** the clock in the Docker Desktop VM against the hub right after resume. A lagging clock can stall WireGuard handshakes.
- **M16:** the distribution of gaps between rounds within a turn, from `turn_spans`, to size the hold grace.
- **M17:** the longest silence in an ollama pull stream (digest verification of the 17 GB blob), to size the D12 timeout.
- **M9 is cut** (no Windows adapters visible under Docker Desktop). The MAC and target come from the owner, or from novad `device_run` of `Get-NetAdapter`.
- **Check the prerequisites at setup and state them.** Read them through existing `device_run`: "Hibernate after", wake-armed devices, the adapter's "Wake on Magic Packet".

**D18. Cuts.**
- The RAM frame: CPU fit is "unknown — no GPU on this engine".
- `nics` and `wake_mac_source='node'`.
- `mac` in `POST …/wakes`.
- Optionally, `library:` ids: keep `ollama:` library rows with `fit_by_engine` unless the web ripple is accepted.

**Corrections to the interfaces required from core.**
- Handle the 409 only in `_gateway_round` (opt-in) and the eval warm-up.
- `model_pull` must handle a 409 by waking and then pulling, or by stating that it cannot.
- Core must not read `/node/activity` directly.
- `stack_chat_model` must treat a missing row for an engine-qualified model as `CannotCheck` when that engine is unobserved or has no cached listing.

### Critical files for implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/routing.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/data_plane.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/admin.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/adapters/ollama.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py