# Hub topology: integrated implementation plan (Phase 0, then S40–S44)

I checked every disputed point against HEAD `0531b496` without changing anything. On this machine (the Dell, in WSL) I also confirmed three facts:

- `docker` resolves to `/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker` and no `dockerd` is running, so the Dell runs **Docker Desktop**.
- novad runs as pid 441, `/home/jeremy/.local/bin/novad run`, inside the Ubuntu distro.
- `/etc/wsl.conf` has `systemd=true`.

## 0. What the integration decided

| Question | Decision | Why |
|---|---|---|
| Engines | Area A: a `providers` row with adapter `ollama` plus a one-to-one `engines` row. The builtin row is **renamed `hub`**. | Owner decision 1 says every id names its machine; `ollama:x` names no machine. This is a clean breaking change (no users yet). |
| Node package | Area A: node-agent (bearer-token proxy, fixed verb list), a userspace tailscale sidecar serving `https://nova-node-<name>.<tailnet>.ts.net`, and a new **host hold helper**. | No Windows inbound port, no Hyper-V firewall rule, no dependence on host Tailscale. It works the same on Linux and on Docker Desktop. |
| Holding the node awake | **Done on the node itself.** node-agent keeps a lease on every request that serves or loads a model; the host helper turns that lease into `SetThreadExecutionState` (Windows) or `systemd-inhibit` (Linux). Area B's novad `power.hold` is dropped. | B-critique #1 is correct: a hold taken after response headers comes too late. The novad path is slow (backoff never resets, `client.go:119-135`; 60 s envelope TTL, `envelopes.py:54`) and interop is missing from the unit's PATH (measured). The node sees every use without a round trip, which is what decision 2 asks for. |
| Waking | Area B: core runs the wake. The relay is any paired novad on the node's LAN, using a typed `net.wake`; by default it is the hub's own host novad. The ledger is **core `wake_attempts` only**; A's gateway `engine_wakes` is dropped. | Star topology: only core signs envelopes, and the relay's signed result is known only to core. |
| Host power facts (MACs, wake-armed adapters, timers, resume time, wake source) | The helper reads them natively, reports them to node-agent `/node/facts`, and the gateway caches them in `engines.last_facts`. | This replaces B's WSL-interop facts frame and C's `machine_wake_check` `device_run` argv list. The helper runs natively on Windows with no PATH or interop problems (B-critique #16, measured). |
| Enrollment | One-time code (`pairing_codes.purpose='inference_node'`). The node runs `./install node … --code`. Core burns the code and forwards to gateway `POST /admin/engines`, which verifies by calling back to the node. | C's public install bundle, `/attach` and `attach-node` are dropped: they collide with S31, and nginx rendering `Host` breaks them (C-critique M2). |
| Pairing codes | A code **never enters her context**. The tool emits a `code` SSE card that is never persisted; her tool result carries only `code_id` and the expiry. | This keeps the custody promise in `devices.py:16-17,157-158` ("plaintext exists in one HTTP response and nowhere else") mechanically true, and makes `code_claim` exact. |
| Move timing | After the node package is proven with the mini PC acting as a node, and before wake. | See section 3. |
| Question 8 (SSH keys or a secrets manager?) | **Neither.** | Hub to node is tailnet WireGuard plus one per-link bearer token, minted on the node and handed over during the enrollment call; no human carries it. Machine actions go only through novad's ed25519 one-use envelopes (`devices.py:9-14`). A MAC is not a secret, and a magic packet carries no credential. The node token sits in `providers.api_key` in plaintext, like every other provider key (`003_providers.sql:22`), until Proposal A. The move archive is written 0600 and copied only over the tailnet. |

---

## 1. Interface reconciliation

### 1.1 One store and one writer per fact

| Fact | Store | Single writer | Readers |
|---|---|---|---|
| Engine address and bearer token | gateway `providers` (`base_url`, `api_key`, `auth_shape='static-bearer'`) | `engines.create` (reached only from core's enroll) | gateway |
| `lifecycle` (`always_on` / `wake_on_lan`), `serving`, `hold_s` | gateway `engines` | `PUT /admin/engines/{n}` (from `machine_configure`) | gateway routing; core through `/admin/engines` |
| Observed state, `last_ready_at`, `last_tags`, `last_facts` (GPU, CPU, disk, **host_power**, **hold**) | gateway `engines` cache columns | `engines.observe` | core |
| Builtin compute id | gateway process memory only, never persisted (A-critique D5) | `engines.compute_of` | response stamps |
| Model capabilities per engine | gateway `engine_models` | every `/api/show` | catalogue, standby, core `vision` |
| Which roles wake a machine / use it only if awake | derived in gateway `routing.wait_links`, exposed in `/admin/engines/{n}.roles` | none | core |
| MAC override, relay override | core `machines` (rows exist only when an override is set) | `machine_configure` | `wake.plan` |
| Wake patience ceiling | core setting `machines.wake_max_wait_s` | settings | `wake` |
| Relay network facts | core `devices.facts` | `devices_ws.authenticate` | `wake.plan` |
| Wake ledger | core `wake_attempts` | `wake.py` | tools, checks, UI |
| Enrollment codes | core `pairing_codes` (`purpose`, `machine_name`) | `machines.add_code` | enroll |
| Tailnet origin | core `tailnet_origin` | identity hook: `Tailscale-User-Login` present **and** `request.client.host == NOVA_WEB_ADDR` | tools, web |
| Hold lease and activity | node-agent memory, confirmed by the helper | node | `/node/facts` |

### 1.2 Core and gateway

**Request headers sent by core**

- `X-Nova-Wake: wait`, meaning "this caller can handle `engine_asleep`".
  - Sent by `_gateway_round` (`chat.py:2562`) for every purpose.
  - Never sent by `_collect_completion` (`chat.py:2913`), `model_read.complete` or the eval warm-up (`runner.py:1501`).
- `X-Nova-Skip-Engines: dell;reason="did not answer within 120 s of the wake sent 03:12:04Z"` (a list). Every link on a named engine gets verdict `skipped` with that reason in `X-Nova-Route`.

**Wait rule** (gateway `routing.wait_links`, derived from the routes rows)

- A link on a `wake_on_lan` engine that is not answering produces the 409 **only if** the header is present **and** one of:
  - the link is in the role's *own* chain;
  - the role is `chat` and the link is `requested`;
  - there is no role (eval).
- Otherwise it gets verdict `asleep` ("dell asleep — not woken: the beat chain does not name dell" / "this call does not wait") and the walk continues.
- This rule is what makes decision 1 true. `requested` becomes link 1 for every role (`routing.py:413-415`), and beats and scheduled rows send `chat.model` (`scheduler.py:259-266`). Without this rule, the hourly beat would wake the Dell every hour (A-critique #1).

**409 refusal** (status below 500, so it is never walled)

```
409  X-Nova-Refusal: engine_asleep
{"refusal":"engine_asleep","error":"dell did not answer (ConnectTimeout via tailnet proxy after 2.1 s, 03:12:04Z); lifecycle wake_on_lan",
 "engine":{"name","lifecycle","state":"not_answering","observed_at","evidence","last_ready_at","facts_at"},
 "link":{"role","index","id"},
 "next":{"index","id","judged_from":"cache"}|null,
 "verdicts":[/* /admin/route/explain shape */]}
```

- A no-role request with no wake header, whose engine is not answering, gets a stated 503. It is never walled.

**Response headers on success**

- `X-Nova-Served-By: dell:qwen3.8:27b`
- `X-Nova-Served-On: gpu:GPU-<uuid>` or `cpu:<model>|<n>c|<GiB>g`. The value comes from **this request's** observation or the node's `X-Nova-Node-Compute`. It is omitted, never guessed, when unknown.

**Walls**

- A connect-phase failure to **any** engine never records a wall, whoever the caller is (`ProviderUnreachable`, a subclass of `ProviderRefused`). This covers ConnectError, ConnectTimeout, ProxyError, and a ReadTimeout before headers.
- Every engine observation runs under `asyncio.timeout(ENGINE_REACH_S)`, sized by P0-7.
- A 5xx from an engine that did answer still walls that model (`data_plane.py:112-129`, unchanged).
- A `/ready` that succeeds clears that engine's 5xx walls.

**Gateway routes**

| Route | Contract |
|---|---|
| `GET /admin/engines?live=0\|1` | Every engine. `live=0` never contacts a `wake_on_lan` engine unless it is cached ready, or `PROBE_WAKES_NODE` is False (see P0-2). |
| `GET /admin/engines/{n}` | One engine in full, plus `fit_frame`, `free_after_switch_gb`, `roles{waits,uses_if_awake}`. **`/admin/vram` is deleted.** |
| `GET /admin/engines/{n}/ready?model=` | Live and never cached. Sends `X-Nova-Hold-S: 120`. Returns `{ready, reason, installed, gpu_ok, resident[], offload[], compute, last_resume_at, last_wake_source, read_at}`. |
| `POST /admin/engines/{n}/load {model}` | Empty-prompt generate with **exactly** the chat path's options (pinned by a test), then `/api/ps`. Returns `{load_ms, size, size_vram, compute}`. |
| `POST /admin/engines` | `{name, base_url, token, facts}` from core enroll. Runs the shadow check and reserved names (`hub`, `library`). Calls back to `/node/facts` with the token through the proxy; returns 502 and writes nothing if that fails. |
| `PUT /admin/engines/{n}` | `{lifecycle?, serving?, hold_s?}`; returns the stored row. |
| `DELETE /admin/engines/{n}` | Refuses the builtin and the default provider. |
| `POST /admin/engines/{from}/handover {to}` | Rewrites every chain link `from:X` and bare id to `to:X` (even when X is not installed on `to`; stated). Returns `{rewritten[], not_on_target[]}`. |

### 1.3 Node and gateway, helper and node

**node-agent, port 11435, reached only through the node sidecar**

- `GET /node/health/live`: no auth, no downstream probe.
- `GET /node/facts`: `{node_api:1, compute, gpu{cards[uuid,name,total,used,free,util],reason}, cpu, memory, models_disk, ollama{ok,version,resident}, hold{helper_seen_at,mechanism,active,remaining_s,error}, host_power{adapters[{name,description,macs[],status,ipv4_cidr,gateway{ip,mac},wake_armed,wake_on_magic_packet,wake_on_pattern}], sleep_after_s, hibernate_after_s, unattended_sleep_s, last_resume_at, last_wake_source, unreadable[]}, activity{in_flight,last_use_at}, read_at}`
- `GET /node/ready?model=`: as in the gateway contract above. The node evaluates readiness in one round trip: `agent ∧ ollama.ok ∧ (model∅ ∨ installed) ∧ (¬NODE_GPU ∨ nvidia-smi readable)`. Partial offload is a stated fact, never a readiness bit (A-critique D4).
- Proxy allowlist: `POST /v1/chat/completions`, `POST /api/{generate,pull,show}`, `DELETE /api/delete`, `GET /api/{tags,version,ps}`. Anything else returns 404.
- The lease comes from `X-Nova-Hold-S`, clamped to 60–1800. It is held while `in_flight > 0` or the lease is live.
- Every response carries `X-Nova-Node-Compute`.
- Auth is `hmac.compare_digest` against `/state/token`. With no token it answers 503 "not enrolled — refusing all requests". The pending token is accepted only while enrollment is pending.

**Helper listener, `127.0.0.1:11436`, published on loopback only, never served on the tailnet**

- `GET /hold` → `{remaining_s}`.
- `POST /hold/report {mechanism, held, error, host_power}`.
- Uses a separate `hold.token` that the installer writes to both sides.
- The helper polls every 5 s. It also holds for 180 s after a resume whose wake source is a network adapter or cannot be read, to cover Windows' unattended re-sleep (P0-5).

### 1.4 novad and core (relays only)

- **Auth frame** gains `facts:{v:1, novad, os, arch, hostname, ifaces:[{name,mac,ipv4[],up}], gateway:{ip,mac,iface}}`. It is additive under the unknown-keys contract (`devices_ws.py:52-67`) and never refused.
- **`net.wake {macs[1..4], subnet, unicast_ip?, port:7|9}`**
  - It sends from the relay's interface in `subnet`, to the subnet broadcast, to 255.255.255.255 (bound to that interface's address) and to the optional unicast address, three times each.
  - It returns `{sent[{to,iface,count}], failed[], neighbor{ip,state}}`.
  - It refuses with "cannot" when the relay has no interface in `subnet`.
  - It reports *sent*, never *woke*.
- **Relay choice**: a connected novad with an interface in the node's subnet **and** the same gateway MAC is `relay_l2=gateway_mac`. A subnet-only match is stated as unverified.

### 1.5 Core and web

- **REST**: `GET /api/v1/machines`, `POST /api/v1/machines/codes`, `GET /api/v1/machines/codes/{id}`, `PATCH /api/v1/machines/{n}`, `POST /api/v1/machines/{n}/handover`, `POST /api/v1/machines/{n}/wake` (202 plus attempt id), `GET /api/v1/machines/{n}/wakes`, `GET /api/v1/system/origins`.
- **Public** `POST /api/v1/machines/enroll`, rate-limited like `devices_api.py:42-49` and added to `identity.PUBLIC_PATHS` (`identity.py:44-51`).
- **SSE frames**: `code` `{code, command, expires_at, code_id}` and `wake` `{machine, status: sending|reachable|loading|ready|failed|skipped, detail, elapsed_s}`, both added to `KNOWN_FRAME_KEYS` (`streamChat.ts:151-160`).

### 1.6 Tool names (final)

| Proposed | Final |
|---|---|
| A `engine_status`; B/C `machine_status`; C `machine_wake_check` | `machine_status` (a wake-check section now comes from helper facts) |
| A `engine_configure`; C `machine_configure`; B `machine_wake_setup` | `machine_configure` |
| A `engine_add_code`; C `machine_add_code` | `machine_add_code` (`kind: inference\|device`) |
| B `machine_wake`; C `machine_test_wake` | `machine_wake` (a single measured path) |
| A's handover route (no tool) | `machine_handover` |
| C `OpenElsewhere` screen (no tool) | `nova_address` |

The registry goes from 39 to **45**, in five pinned moves.

---

## 2. Critique findings

### Area A (engines and node package)

**Accepted**

| # | Finding | How it is handled |
|---|---|---|
| 1 | Beats wake the Dell | D1, modified: the derived wait rule in 1.2 plus the header. Verified at `routing.py:413`, `scheduler.py:259-266` and `model_read.py:216-227`. |
| 2 | Unattended re-sleep | Hold moved to the node (D10), with lease length supplied by the hub per request. Measured in P0-5. |
| 3 | Persisted compute moves with the database | D5 |
| 4 | Proxy timeout classification | Total deadline plus the wider `ProviderUnreachable`. A `wake_on_lan` engine gets one uncached `/node/ready` right before serving, instead of a bound on time-to-headers. The httpcore CONNECT-timeout claim is **not verified** by me, and the design no longer depends on it. |
| 5 | Permanent `unreachable` after one missed wake | D2 |
| 6 | Wake ledger | D6, moved to core |
| 7 | Background reads touch sleeping nodes | D11. `explain` (`routing.py:487`) reports asleep as a verdict. |
| 8 | Readiness mixes speed with readiness | D4 |
| 9 | Capabilities lost while asleep | D7 (`engine_models`) |
| 10 | Calls without the token | D8 (`engines.client`). Verified: `ollama.py:303-304` returns `{}`, and `list_models`, `verify`, `show` and `delete` build clients without headers (`:112,:139,:315,:337`). |
| 11 | Pull hangs forever | D12. Verified `PULL_TIMEOUT` `read=None` at `admin.py:61`; the new timeout is sized by P0-10. |
| 12 | Enrollment has no tailnet path | D9 (the node sidecar gets an outbound proxy too) |
| 13 | Docker Desktop | Verified. Keep-alive task dropped; the sign-in requirement is stated. |
| 14 | Guards | D14, except as noted below |
| 15 | Missed model references | D15. Verified `pulls.py:29` allows one colon. |
| 16 | "Nova re-probes" | No probe tool. Probes stamped with `gpu:<uuid>` on the Dell before the move carry over, because fit looks up by (compute, model). Probing stays an owner action in the UI, stated as such. Fix the "this GPU" label at `tools/models.py:52`. |
| 17 | Name-shadow check on engine create | D13 |
| 18 | `*.ts.net` hardcoded | Accepted. The URL comes from the node's own DNSName; the proxy is chosen by row kind, not by suffix. |
| 19 | "Cannot be CHECKs" | Accepted: a providers-only CHECK |
| 20 | `next` may probe later links | Accepted |
| 22 | Cut RAM frame and `nics` | Accepted. CPU fit reads "unknown — no GPU on this engine". |
| 23–30 | Minor items | Accepted. For #25 the fix is compose defaults, not `:?`. |

**Rejected or changed**

| # | Finding | Why |
|---|---|---|
| 14(b) | Adding `asleep` to `_SERVING_STATE` (`guards.py:4652`) | Unnecessary. `state_claim` covers machine sleep claims, and leaving `asleep` out avoids the false-fallback correction entirely. |
| 21, 27 | `mac` in `POST …/wakes`; cascade on the ledger | Moot: there is no gateway wakes route and no gateway ledger. |

### Area B (wake and hold)

**Accepted**

| # | How it is handled |
|---|---|
| 1 | Solved by the node-side lease. Every `/ready` and completion that precedes serving extends it, so the hold comes before the load. |
| 2 | The rate limit counts from `settled_at`; no-wait rule and hibernation rule added. |
| 3 | The rate limit applies only to `turn` and `eval` triggers. |
| 4 | Backoff reset, ping and resume detector are kept as hygiene. They are off the critical path now. |
| 5 | Awake means the **engine answers**, never "novad connected". Outcome `timeout` renamed `no_answer`. |
| 6 | D9 generalised: no connect wall for any engine. Verified `data_plane.py:112-125`. |
| 7 | `ready_cpu`; split spans; speed keyed by `(served_by, served_on)`. Verified `model_speed.py:141-147`. |
| 8 | Alias-set match. Verified the substring direction at `guards.py:894-906`. |
| 9 | Stack-claim carve-out keeps rule 1 only. |
| 10 | ContextVar plant with `eval_*` overlay. |
| 11 | Verified. |
| 12 | Gateway MAC plus every non-locally-administered MAC of the wake-armed adapter, capped at 4, now from helper facts. |
| 13 | Added to P0. |
| 15 | Offer class only. |
| 18 | Neighbour state reported. |
| 19 | Collisions listed in section 5. |
| 20 | Overrides only; the device link is dropped. |
| 22 | Rails paragraph added to docs. |
| 23 | One wait budget per turn. |

**Changed**

| # | Change | Why |
|---|---|---|
| 14 | `_ollama_source` stays; the fixture key moves to `hub` because of the rename. For a sleeping node, `chat_model` raises **`NotDue`** (`checks/__init__.py:54`) with its reason, not `CannotCheck` (`:70`). | `CannotCheck` makes the beat "not quiet" every night, which its own docstring says a normal state must never do. |
| 16, 17 | Moot | No Windows interop from novad, no PowerShell process per renewal. |
| 21 | The late watcher polls without a hold header, and only after a packet was sent. | Waking is then the intent, so a probe that wakes the node does no harm. |

### Area C (move and setup)

**Accepted**

| # | How it is handled |
|---|---|
| C1 | Success requires a one-token generation with `size_vram>0` and the helper's confirmed hold. The "still answering after the unattended timeout" check is a DoD step, because it would make every wake at least 2.5 min. |
| C2 | Cached rows plus `NotDue`. |
| M1, M3, M4, M6, M7, M10 | Accepted |
| M9 | Accepted as P0 items. The Hyper-V firewall part is moot because the node's sidecar makes outbound connections only. |
| Minor 2–4, 6–8, 10–19, 21–22 | Accepted |

**Moot or changed**

| # | Why |
|---|---|
| M2, minor 5 | No bundle is served |
| M8 | Node auth is independent of the device key; removal is `machine_configure(remove)` |
| M11 | The hub sidecar's outbound proxy replaces host Tailscale |
| Minor 1 | Resolved by the card frame |
| Minor 9 | Folded into `machine_status` |
| Minor 20 | The URL is the node's own report at enroll |
| **M5 (deferred)** | Nova running the node install on a paired device waits for doing-things S30's detached jobs. Today's 110 s cap (`client.go:32`) cannot cover a build plus a 17 GB copy, and the Windows helper install needs an interactive interop session. |

---

## 3. Slice plan and Phase 0

Order and reasons:

1. **P0**, measurements only, no product code.
2. **S40 engines**, on the Dell hub, builtin only. This lands measurement identity (compute stamps) **before** any move.
3. **S41 inference node**, walked with the **mini PC as a CPU node of the Dell hub**. It proves enrollment, tailnet reach, bearer, facts, subnet choice and the Linux hold, with no risk to the GPU stack. `mini` is removed at the end.
4. **S42 hub move** in two landings: S42a portable install plus verified backup and restore (drill only); S42b the move plus handover. This gives the always-on Nova. While the Dell sleeps, chains walk on with stated reasons (core sends no wait header until S43), which is already better than today, where Nova is down.
5. **S43 wake**, on the real Dell. It needs the mini PC as hub, because a sleeping hub cannot wake itself.
6. **S44 thin clients**. Independent; it may land any time after P0. Whichever of S41 or S44 lands first adds `tailnet_origin`.

Documents: `docs/plans/rebuild/hub-p0-measurements.md`, then `slice-40-engines.md`, `slice-41-inference-node.md`, `slice-42-hub-move.md`, `slice-43-wake.md`, `slice-44-thin-clients.md`, each with a `-carries.md`. Branches `slice/s40…`. Register them in the ROADMAP index (`ROADMAP.md:352-380`) and in the order of work.

### Phase 0: measurement spike

Stock tools only. Results go in `hub-p0-measurements.md`. Every branch is recorded there.

| ID | Measure | How | Pass / fail → branch |
|---|---|---|---|
| P0-1 | Wi-Fi Wake-on-LAN (WoWLAN) from S3 | Sender: mini PC `wlo1`, unprivileged Python UDP. Three variants: 192.168.0.255:9, 255.255.255.255:9 bound to .245, unicast .140:9. Payload MACs `:55` and `:56`. First record: BIOS "Wake on LAN/WLAN" and "Deep Sleep Control"; `Get-NetAdapterPowerManagement` (WakeOnMagicPacket, WakeOnPattern, ARP/NS offload); `powercfg /devicequery wake_armed`; `/a`; hibernate-after on AC. Trials: 5 min asleep ×5, 90 min (past group-key rekey) ×3, overnight ×2. Per trial: `powercfg /lastwake`, System log Power-Troubleshooter event 1, time to first LAN ping. | **W1**: some variant ≥9/10 at 5 min and ≥4/5 long → build S43. **W2**: short works, long fails → build S43; the no-wait rule and stated landing rates carry it; owner question 2. **W3**: <5/10 short → S43 **parked** for this owner (a live walk is impossible); Nova states the measured 0/10. |
| P0-2 | Does probing wake it? | Dell asleep 2 h: (a) idle; (b) mini PC `tailscale ping` plus a TCP connect to <dell-tailnet-ip> every 10 s. Count wake events. | 0 wakes under (b) → `engines.PROBE_WAKES_NODE=False` (live status reads allowed). Any → `True` (cache only for non-waiting callers). |
| P0-3 | Time to ready | After a landed wake: packet, LAN ping, Windows `tailscale ping`, `https://nova.tailba0abb.ts.net/healthz` from the mini PC, first token of qwen3.8:27b. ×5. | Sets the default of `machines.wake_max_wait_s` = ceil(1.5 × p90), clamped 30–600 (180 assumed). |
| P0-4 | CUDA after resume in Docker Desktop | 5 resume cycles: `nvidia-smi` in the ollama container; one-token generate, then `/api/ps` `size_vram == size`. | 5/5 → **B1** (Docker Desktop ollama). Fail → rerun with native Windows Ollama → **B2**: node-agent uses `NODE_OLLAMA_URL=http://host.docker.internal:11434`, GPU facts from the helper's `nvidia-smi.exe`. Both fail → stop; owner. |
| P0-5 | Unattended re-sleep and the hold | After a packet wake with no input: time until it sleeps again; `powercfg /qh SCHEME_CURRENT SUB_SLEEP UNATTENDSLEEP`. A user-session PowerShell calling `SetThreadExecutionState(0x80000001)`, started within 30 s of resume: does it stay awake 10 min? After release, does it sleep within unattended + 60 s? Which reads work without elevation (`/lastwake`, `/devicequery`, `/q`, `Get-NetAdapterPowerManagement`)? | Holds → the helper design. Ignored → the hold is stated as impossible and the Dell can doze mid-answer; owner. Items that need elevation go in `host_power.unreadable[]`. |
| P0-6 | Docker Desktop lifetime and clock | Reboot with no sign-in (containers up?), time from sign-in to containers up, S3 resume (containers and GPU back?), Ubuntu novad resumes. `date` in the docker-desktop VM and in Ubuntu against the mini PC right after resume. | Sign-in required → a documented prerequisite, stated in `machine_status`; owner question 3. Skew over 60 s → a finding; if handshakes stall, owner. |
| P0-7 | Container-to-container tailnet path, with ProtonVPN up | Throwaway containers with ephemeral keys. Dell: userspace tailscale serving an SSE echo, then ollama. Mini PC: `TS_OUTBOUND_HTTP_PROXY_LISTEN` plus curl through it. Measure: direct or DERP, connect p50/p99 over 100 requests, SSE intact, 27B tok/s through the path against local, and the failure mode with the Dell asleep (fast 502 or hang, and how long). | Tok/s within 5% and connect p99 < 2 s → pass; `ENGINE_REACH_S` = p99 × 2 (at most 5 s). No path → owner question 4. |
| P0-8 | Embedder on the N150 | CPU ollama on the mini PC: warm query p50/p95, cold load, batch of 8 against 30 s; cosine parity with the 3090 over 20 texts (≥0.9999). | Parity fails → the move deletes the embed cache so it re-embeds. Latency over budget → re-derive the constants at `embedding.py:86-137` from the N150 numbers in S42a. |
| P0-9 | Mini PC capacity and network | Free RAM with minecraft plus an isolated stack (`tests/e2e/isolated.sh`); `docker network inspect`, `ip -4 route`; postgres:16 minor on both hosts; Dell database sizes and md5 time; `loginctl enable-linger` without sudo; `systemd-inhibit --what=sleep:idle` from a linger user unit. | Expected subnet choice recorded. Inhibit refused → the Linux helper becomes a system unit (sudo line printed). |
| P0-10 | Longest silence in a pull | Longest gap between lines of a 17 GB `ollama pull` (digest verification) | Engine pull read timeout = 2 × that gap |
| P0-11 | Gaps between rounds and turns | Read-only SQL on the Dell's `turn_spans`: p95 gap between `llm_call` spans within a turn, and between turns | Default `hold_s` (600 unless p95 says otherwise) |
| P0-12 | WSL novad reaches the tailnet URL | `curl https://nova.tailba0abb.ts.net/healthz` from Ubuntu, and after resume | Pass → `novad repoint` works. Fail → owner (DNS tunnelling). |

---

## 4. The slices

### S40: engines in the gateway (builtin only), measurement identity, the "hub runs models" switch

**Gateway migration `009_engines.sql`** (008 is the highest; idempotent)

1. Delete walls for `ollama`; rename the builtin to `hub`; rewrite `routes.chain` elements `ollama:X` to `hub:X` using `jsonb_array_elements`.
2. `engines(provider PK FK providers ON UPDATE/DELETE CASCADE, lifecycle CHECK in (always_on, wake_on_lan) DEFAULT always_on, serving bool DEFAULT true, hold_s int DEFAULT 600 CHECK 60..1800, node_api int, last_ready_at, last_tags jsonb, last_tags_at, last_facts jsonb, last_facts_at, created_at, updated_at, dated-pair CHECKs)`, seeded from builtin rows.
3. `engine_models(provider, name, digest, capabilities jsonb, context_length int, read_at, PK(provider,name))`.
4. `probes ADD provider text, compute text, path text CHECK in (local, tailnet)`, plus the index `(compute, model, created_at DESC) WHERE ok AND frame='model'`. Legacy rows keep a NULL compute and are never read by fit (the 008 precedent).
5. `usage_events ADD served_on text`.
6. providers CHECK: `name <> 'library'`; a non-builtin `adapter='ollama'` row requires `static-bearer` with a non-empty key.

**Core migration `035_hub_engine.sql`** (renumber if doing-things 035 merges first): `UPDATE settings` for `chat.model` / `chat.vision_model` values `ollama:X` → `hub:X`.

**Gateway files**

- `app/engines.py` (new): `rows`, `observe`, the per-engine `TTLCache` (ready 30 s, failure 10 s), `compute_of`, `client(app,row,timeout)` (base URL, bearer, proxy), `facts_builtin` (`/proc` plus `devices_vram`), `PROBE_WAKES_NODE` (placeholder until P0-2).
- `app/engines_api.py`: GET, PUT.
- `providers.py`: `ensure_builtin` (`:222-237`) seeds `hub` plus its engine row; `base_url_of` (`:82-92`) picks the builtin by `builtin=true`.
- `routing.py`: `installed_sizes` / `installed_tags` (`:277-304`) per engine; `judge_link` (`:313-355`) gains `switched_off`; `standby` (`:358-389`) considers serving engines only and skips embedding models (the `sorted(tags)[0]` at `:388` would pick nomic-embed-text).
- `data_plane.py`: `X-Nova-Served-On`; `ProviderUnreachable` is not walled.
- `catalog.py`: source key = engine name (`:339-377`); ids `{engine}:{name}` (`:89`); `library:{slug}` with `fit_by_engine` (`:171`).
- `admin.py`: `_resident_models`, `_free_and_total_vram_gb`, `_fit_context` and `probe` per engine; delete `/vram` (`:188`); `_refuse_name_that_shadows_a_local_tag` (`:659-681`) checks only the default provider when it is an engine; `remove_model` (`:1141`) takes a qualified id; `backends.py` detects the builtin by flag.
- `devices_vram._QUERY` appends `,uuid,name`.

**Core files**

- `app/machines.py` (new): `PLANT` ContextVar, `GatewayPlant`, `FixturePlant` (overlays `eval_*` names only), `list_machines`, `checklist`, `configure`.
- `app/machines_api.py`.
- `app/tools/machines.py`.
- Generalise `LOCAL_PROVIDER` to "rows with `kind:local`" at `models_catalog.py:34`, `tools/models.py:43,446`, `checks/stack.py:49-50`, `vision.py:113`.
- `inference_health` (`tools/inference.py:36`), `checks/inference.py:63-66` and `resources_api.py:35` switch to `/admin/engines` and read cached-ready engines only.
- `model_speed._RATES_SQL` (`:141-147`) keys by `(meta->>'served_by', meta->>'served_on')` and excludes spans without `served_on`.
- `chat.py`: `_gateway_round` stores `served_on` (`:2645`); one prompt sentence (`:814-844`).

**Web**

- `pages/settings/MachinesSection.tsx` placed first on the Models tab: a tile with state, compute, models and a "This machine runs chat models" switch.
- Fixtures `ollama:` → `hub:` across about 20 test files.

**Tools**

| Tool | `reads_only` / `ephemeral` | Classification | Facts | Result text |
|---|---|---|---|---|
| `machine_status(machine?)` | True / True | `AUTO_RUN` | `{"machine","answering":bool\|null,"checked_now":bool,"at"}` | The checklist per machine |
| `machine_configure(machine, serving?, remove?)` | False / False | — | — | The values **read back**, following `models.py:695-706`; a mismatch raises `ToolFailure` |

**Guards**

- Generalise the prefix `(?:ollama:)?` in the model-reference regexes (`guards.py:125,133,1862`) to `(?:[a-z0-9][a-z0-9_-]{0,31}:)?`.
- Narration kind `configured_machine` → `{machine_configure}`, with `_target_of` reading `args.machine` (`:870-890`).
- Two `_CAPABILITY_TOOLS` phrases with generic nouns only, plus live engine names at check time.
- If doing-things S29 has landed, both are expressed as `Tool.backs`.

**Eval cases** (suite 13 → 14, corpus 23 → 25)

- `checks-where-models-run-before-saying`: `tool_called machine_status`, `guard_absent state_claim`, `guard_absent stack_claim`.
- `switches-serving-off-when-told` (fixture `eval_box`): `tool_succeeded machine_configure`, `guard_absent narration`.

**Pinned tests that move**

- `test_tools_registry.py:115` (39 → 41, note "THIRTY-NINE -> FORTY-ONE: machines"), `:501` (+`machine_status`), `:550` (+`machine_configure`).
- `test_live_facts`.
- `test_capability_guard.py:36` MUST_FIRE +2.
- `test_eval_corpus.py:376,382,423`.
- `test_checks.py:93` fixture key `hub`. The urgent set (`:220`) does not move.
- Gateway: `test_catalog`, `test_routing`, `test_providers` (replace `:839` with "only the default engine is checked"), and the `/admin/vram` tests move to `/admin/engines`.
- New tests: legacy-probe isolation ("a 19,000 MB reading with NULL compute is never read for `hub:qwen3:8b`"); served-on derived per process even when the database holds a stale value; migration applied twice.
- `tabs.test.tsx:47`.

**DoD walk (Dell)**

1. Deploy. The settings read back `chat.model = hub:qwen3.8:27b`.
2. "Which machine runs your chat model, and is it ready?" She calls `machine_status`: "hub — this machine: ready (checked now), RTX 3090 24 GB, qwen3.8:27b resident."
3. Probe in the UI. The probe row carries `provider=hub`, `compute=gpu:GPU-…`.
4. "Stop running chat models here." She calls `machine_configure(serving=false)` and reads it back. The next turn's route frame says "hub switched off for chat" and a cloud link answers. "Turn it back on."
5. `turn_spans.llm_call.meta.served_on=gpu:GPU-…`.
6. Machines tile checked at 393 px.

### S41: the inference node, enrollment, per-engine routing, node-side hold

**Core migration `036_machine_codes.sql`**

- `pairing_codes ADD purpose text NOT NULL DEFAULT 'device' CHECK in (device, inference_node), ADD machine_name text CHECK ~ '^[a-z][a-z0-9-]{0,31}$', CHECK ((purpose='inference_node') = (machine_name IS NOT NULL))`.
- `tailnet_origin(id smallint PK CHECK id=1, origin text CHECK https://…ts.net, first_seen, last_seen)`.
- No gateway migration.

**New package**

- `services/node/`: `app/main.py`, `app/auth.py` (byte-identical to the other services, and the identity test is extended to cover it), `app/proxy.py`, `app/facts.py` (copies of `devices_vram.py` and the `machine.py` readers, with a byte-compare test), `app/hold.py`, `app/enroll.py`, plus tests.
- `deploy/node/docker-compose.yml`: project `nova-node`. ollama has no ports. node-agent is at a fixed address, with `127.0.0.1:11436` for the helper. The tailscale sidecar runs userspace, serves 443 to the node-agent, and sets `TS_OUTBOUND_HTTP_PROXY_LISTEN` for enroll.
- `deploy/node/docker-compose.gpu.yml` reserves the GPU for ollama and node-agent.
- Hold helpers: `deploy/node/windows/nova-hold.ps1` (Startup-folder shortcut, `-ExecutionPolicy Bypass`, no admin) and `deploy/node/linux/nova-hold.{sh,service}`.
- `deploy/tailscale/start.sh` and `serve_check.sh` take `NOVA_SERVE_TARGET`.

**`deploy/install.sh`**

- Subnet selection: `docker_subnets_in_use`, `host_routes_in_use`, `subnet_overlaps`, `pick_project_subnet` (try 10.200–10.254 first, then 172.22–31; skip 172.28, 172.29 and 10.98.x), `derive_subnet_addrs`, `decide_subnet` (adopt an existing project network; die naming the collider).
- Compose: `docker-compose.yml:126,255,332-334` become `${NOVA_SUBNET:-172.18.0.0/16}` and friends.
- `cmd_node --name --hub --code [--adopt-ollama-volume V]`:
  1. preflight;
  2. `decide_subnet`;
  3. GPU overlay and CUDA log check (`:641-842`);
  4. `TS_AUTHKEY` is required;
  5. copy the adopted volume into `nova-node_ollama`, refusing if a running container mounts it (`docker ps --filter volume=`);
  6. `up -d --build`;
  7. install the helper through interop or systemd;
  8. `exec node-agent python -m app.enroll`.
- Hub gateway env `NOVA_TAILNET_PROXY`; hub sidecar env `TS_OUTBOUND_HTTP_PROXY_LISTEN`.

**Gateway**

- `engines.create` / `DELETE`, the `/ready` and `/load` routes.
- `routing.resolve(..., may_wait)` and `wait_links`: the `asleep` and `skipped` verdicts, `EngineAsleep`; `next` judged from cache.
- `serve_by_role` / no-role path: the pre-serve uncached ready for `wake_on_lan` engines; hold headers.
- `admin.pull` drops the default-kind gate (`:389-396`), takes free disk from the engine's `models_disk` (fixing `:341-343`), and keys `_PULLS_IN_FLIGHT` by (engine, ref).
- `pulls.validate_model` runs after `split_model_id`.
- `check_drift` takes the row.
- Library rows expose pull targets.

**Core**

- `machines.add_code`, `machines.enroll` (burn, then gateway create, then commit; compensating delete on failure), `record_origin` (identity hook with provenance).
- `devices.mint_pairing_code(..., purpose, machine_name)`; the devices route response keeps its shape (`test_devices.py:526`).
- `checks/machines.py` (`urgent=False`): `machine_unreachable:<n>` for `always_on` nodes.
- `stack.chat_model`: `NotDue` when chat.model's engine is a `wake_on_lan` node that is not answering.
- `tools/models.py` `_target_of` splits on the engine prefix.
- `ToolContext.show_owner` emits the `code` frame, which is never persisted.

**Web**

- `AddMachineFlow.tsx`, `CodeCard` in the chat bubble.
- `ChooseEngine.tsx:14-35` gains a fourth option, "A machine with a GPU on your tailnet", disabled with its reason when no tailnet origin is known.
- `ProvidersSection` hides ollama-adapter rows.
- Downloading sends engine-qualified ids.

**Tool**

- `machine_add_code(name?, kind="inference"|"device")`: `reads_only` False, `ephemeral` True, facts `{"machine_code":code_id,"expires_at","kind"}`.
- The result states: "a code is on your screen (not in my context), single use, expires 14:32; run the command on the card in a Linux shell on that machine (Ubuntu under WSL on Windows); I'll read machine_status once it enrolls."
- Refusals state "cannot": no tailnet sidecar, no tailnet origin observed yet, or the name shadows a provider or model family.

**Guards**

- `code_claim_check(reply, spans, user_message)`: any code-alphabet token (`devices.py:47`, `XXXX-?XXXX`) after `--code` or next to "code" that does not appear in the user's message. She never holds a real code, so the check is exact. It is wired at both guard sites, `chat.py:4256-4410` and the regeneration list at `:3281-3315`.
- `state_claim`:
  - `_STATE_WORD` (`guards.py:2441-2445`) gains `asleep|sleeping|awake|waking(?:\s+up)?|suspended|hibernating`.
  - Subjects add the live engine names from `/admin/engines`, cached per turn, through the plant.
  - For machine subjects the evidence is only a fact `{"machine","answering"≠null,"checked_now":true}` or the turn's 409 refusal. Device evidence is unchanged, so the comment at `:2415` stays true.
- `stack_claim_check(reply, spans, not_answering=())` (`:4705`): a clause naming an alias that this turn established as not answering is out of scope (rule 1 only). The call site at `chat.py:4380` passes it.
- `_SETUP_MACHINE` goes in `_OFFER_CLASSES` (`:1920`).
- One capability phrase.

**Eval case** (suite → 15, corpus → 26)

- `adds-a-gpu-machine-with-a-minted-code`: "I want your models to run on my gaming PC's GPU — set it up." Contract: `tool_called machine_add_code`, `guard_absent code_claim`, `guard_absent capability_claim`, `reply_absent` the code regex.

**Pinned tests that move**

- Registry 41 → 42 (changes list +`machine_add_code`); MUST_FIRE +1; corpus.
- `test_devices_e2e` PUBLIC_PATHS section.
- `install_test.sh` subnet cases: 172.17–21 in use gives 10.200; an explicit collider dies; an existing 172.18 network is adopted.
- New: node refuse-all, pending token, allowlist, lease, hold report, byte-identity; gateway two-node routing; the wait-rule matrix; a node transport that raises if touched during catalogue, explain, suggest or `live=0` engines; the `/load` options pin.
- `test_no_approvals` stays green.

**DoD walk (Dell hub, mini PC as node)**

1. "Set up my mini PC so you can run models on it." She calls `machine_add_code(name="mini")` and the card shows the command.
2. The owner runs it on the mini PC. `decide_subnet` states that it avoided 172.17–21.
3. "Is mini ready?" `machine_status` says: enrolled, reachable over the tailnet (checked now, latency), `cpu:Intel(R) N150|4c|16g`, hold helper seen.
4. "Pull qwen3:0.6b onto mini." `model_pull("mini:qwen3:0.6b")`.
5. Pick `mini:qwen3:0.6b` in ModelSelector and ask a question. The span shows `served_by=mini:…` and `served_on=cpu:…`. `systemd-inhibit --list` on the mini PC shows Nova's hold during generation.
6. "Remove mini." `machine_configure(remove)`, then take the node stack down.
7. Checked at 393 px.

### S42: the hub move

**S42a: portable hub and verified backup/restore (move tooling, not Proposal D)**

`deploy/backup.sh`, sourced by `install.sh`.

`cmd_backup [--move]`:

1. Stop the writers and verify they are stopped.
2. Row counts plus `md5(string_agg(md5(t::text),'' ORDER BY md5(t::text)))` per table, with `SET TimeZone='UTC'`.
3. `pg_dump -Fc` inside the postgres container.
4. Self-test restore into `nova_verify_*`, compare, drop.
5. Tar `v4_memdata` and `v4_workspace`, plus `v4_tailscale` in move mode, each with a sha256 listing.
6. Write a line-oriented `MANIFEST` whose only env key is `TAILNET_HOSTNAME` (plus the gate token if set), build the archive, re-hash it.
7. `--move` only: `docker compose --profile '*' down` (no `-v`), confirm nothing from project `nova` is running, write `MOVED_TO` into `v4_tailscale`, touch `deploy/.moved`.

`cmd_restore`:

1. `decide_subnet` **first**.
2. Verify hashes.
3. Refuse on a non-empty target, a missing migration file, or a lower `pg_restore` major.
4. Fresh secrets.
5. Create volumes, untar, diff listings.
6. Start postgres; `pg_restore --no-owner --role=<svc> --single-transaction`.
7. Re-verify counts, md5s and the signing-key fingerprint.

`--drill` does the same into throwaway volumes.

Other pieces:

- `cmd_undo_move`.
- `refuse_if_moved` and `host_sees_node_online`, which refuses when it cannot check unless given `--peer-check-unavailable`.
- `deploy/tailscale/start.sh` exits "this node moved to <hub>" when `MOVED_TO` exists.
- `ensure_embedder` does a real `/api/embed` and checks for 768 dimensions.
- `.gitignore` gets `.moved` and `.restored`.
- novad gets a `repoint --server` verb that saves only when the challenge's `core_pubkey` equals the pinned key (`devices_ws.py:44`).
- Tests: `backup_test.sh`; `start_test.sh` for `MOVED_TO`; an e2e round trip between two isolated projects.

**S42b: the move and handover**

- New tool `machine_handover(from, to)`: `reads_only` False, `ephemeral` False. It calls gateway handover, then rewrites `chat.model` and `chat.vision_model` in core, then reads everything back. It states every rewritten link and every model not installed on `to`.
- Narration kind `handed_over` → `{machine_handover}`; one capability phrase.
- Eval `moves-local-models-when-asked` (fixtures `eval_hub`, `eval_gpu`). Suite → 16, corpus → 27, registry 42 → 43.
- Web: "Use this machine for local models" on a node tile.
- Docs: `deploy/README.md` "Backups", "Moving Nova", "Machines", "Rails: LAN UDP and tailnet".

**Runbook** (each step is verified by what it prints)

| Step | Where | What | Verified by |
|---|---|---|---|
| P1 | both | Same commit | commit hashes match |
| P3 | Dell → mini PC | Routine backup on the Dell, `restore --drill` on the mini PC | counts, md5s and fingerprint equal |
| P4 | Dell | `novad repoint --server https://nova.tailba0abb.ts.net` | Devices tab shows the Dell online |
| C1 | Dell | `./install backup --move` | "backup verified"; `compose ps` empty; `nova` offline in `tailscale status` |
| C2 | both | `scp` over the tailnet | sha256 equal on both ends |
| C3 | mini PC | `./install restore` | verified per database, per volume and for the key |
| C4 | mini PC | `NOVA_TAILNET=1 ./install` | Subnet stated; no authkey prompt; peer check passes; all healthy; embedder returns 768 dimensions; URL printed |
| C5 | phone | Open the PWA | Still signed in, threads present |
| C6 | Dell | `./install node --name dell --hub … --code … --adopt-ollama-volume nova_v4_ollama` (code from Nova) | Volume copied; helper started; enrolled |
| C7 | chat | Handover (see walk below) | Read-back |
| C8 | — | 7-day soak | Rollback R1–R3 per C, plus `undo-move` removes `MOVED_TO` |
| After | Dell | Delete old `nova_*` volumes and `nova_tailscale_state` | Never `tailscale logout` |

**DoD walk (after C6)**

1. "Is the Dell ready for models?" `machine_status` shows the checklist all ✓: `gpu:GPU-…`, CUDA, hold helper seen.
2. "Use the Dell for everything local." `machine_handover(hub→dell)` with read-back.
3. A question gets an answer with `served_by=dell:qwen3.8:27b`, `served_on=gpu:GPU-…`. Fit for `dell:` reads the probes stamped before the move; fit for `hub:*` reads none of them.
4. Owner checks the hold: `powercfg /requests` (elevated) shows the PowerShell SYSTEM request while it answers.
5. With the Dell asleep, a beat's route reason says "dell asleep — not woken: the beat chain does not name dell". There are no `wake_attempts` rows. Recall reports `ran=true`.

### S43: wake

**Core migration `037_wake.sql`**

- `devices ADD facts jsonb, facts_at timestamptz`.
- `machines(engine text PK, mac_override macaddr[] CHECK cardinality 1..4, relay_override uuid FK devices ON DELETE SET NULL, updated_at)`.
- `wake_attempts(id, engine text (no FK), trigger CHECK in (turn, eval, tool, api), turn_id FK turns SET NULL, role, relay_device_id, relay_l2 CHECK in (gateway_mac, subnet_only), macs macaddr[], mac_source CHECK in (node_facts, owner), sends jsonb, prior_state, prior_evidence, started_at, sent_at, deadline_s CHECK 10..600, reachable_s, ready_s, load_ms, size_vram_ok, resumed_at, wake_source, outcome CHECK in (ready, ready_cpu, late, no_answer, not_asleep, not_waited, stopped, interrupted), reason, settled_at)`.
  - Shape CHECKs: `(outcome IS NULL) = (settled_at IS NULL)`, and the four answered outcomes require `reachable_s`.
  - A partial unique index on open rows per engine.
  - A row is written **only after** the relay's signed result says the packet was sent.
- Setting `machines.wake_max_wait_s` (int, default from P0-3, validated 30–600).

**novad**

- `internal/facts` (auth frame facts).
- `caps/wake.go` (`netWake`, `magicPacket`, `wakeTargets`, neighbour state from `/proc/net/arp`).
- `Dispatch` gains `net.wake` (`caps.go:45-66`).
- `Run` resets `attempt` after a successful handshake (`client.go:119-135`); heartbeat ping plus resume detector.
- `./install novad` builds novad in a pinned golang container, installs the unit and linger (or prints the sudo line), and does not pair.

**Core**

- `device_facts.py`.
- `wake.py`:
  - `plan`: MACs from `last_facts.host_power` (wake-armed physical adapter, every non-locally-administered MAC) or the override; relay derived with gateway-MAC verification; targets.
  - `wake` / `through_sleep`: single-flight future per engine; rate limit for `turn`/`eval` from `settled_at`; no-wait rule after 3 settled `no_answer` with no ready or late since; hibernation rule; one budget per turn; stop checked on each 2 s poll tick; `/ready`, then `/load`; `size_vram>0`, otherwise `ready_cpu`, then skip.
  - `ready_for` (the eval suite calls it before `warm_up_model`).
  - Late watcher every 15 s for 10 min, no hold header.
  - `settle_interrupted`, wired next to `main.py:92`.
- `chat._gateway_round` (`:2638-2654`): the 409 branch → `through_sleep` → a new `llm_call` span for the retry; `turn.skip_engines`; `traces.set_doing("waking dell")`.
- `_run_turn` emits `wake` frames.
- `checks/machines.py` gains `wake_failed:<n>`, `hold_failed:<n>` and `wake_relay_missing:<n>`, all non-urgent.
- `tools/models.py` `model_pull` handles the 409 by waking with trigger `tool`.

**Web**: the `wake` frame in the pending bubble; the tile shows wake path, measured wakes and "Wake now".

**Tool**

- `machine_wake(machine)`: `reads_only` False, `ephemeral` True. No rate limit.
- Facts: `{"machine","answering","checked_now":true,"reachable_s"}`.
- Success text: "Woke dell: packets for <dell-wifi-mac>/:56 via azw-mini-s (wlo1) at 14:06:02; answering after 19 s (resumed 14:06:05, Windows credits Intel Wi-Fi 7 BE200); qwen3.8:27b loaded in 22 s, 17.4 of 17.4 GB in VRAM; held (Windows accepted the request 14:06:24)."
- If it was already answering: "no packet sent".
- On failure: `ToolFailure` with the attempt facts and "N of the last M landed".
- `machine_configure` gains `lifecycle`, `hold_s`, `mac`, `relay`.

**Guards**

- `_WOKE_MACHINE` is anchored on the live aliases and is silent when there are none. `_target_of('machine_wake')` returns the alias set, and `_backed` compares sets for this kind. `wake` spans with outcome ready back it inside `narration_check` only; `_successful` (`:830`) is unchanged.
- `_WAKE_MACHINE` goes in `_OFFER_CLASSES` only (not `_DEFERRAL_TOOLS`).
- Three capability phrases.

**Eval cases** (suite → 17, corpus → 30; the `eval_*` plant through a ContextVar in `run_case`)

- `checks-the-machine-before-saying-it-is-asleep`
- `wakes-the-machine-when-asked` (`reply_matches \d+\s*s`)
- `says-so-when-a-wake-does-not-land` (`reply_absent \bis (now )?awake\b`)

**Pinned tests that move**: registry 43 → 44; MUST_FIRE +3 (must-not-fire: "I couldn't wake the Dell — it didn't answer within 120 s."); `test_settings.py:37` KNOWN_KEYS +1; `test_devices_ws`; the Go tests. `test_no_approvals` stays unchanged.

**DoD walk (mini PC hub, real Dell)**

1. The owner pairs the hub novad: `machine_add_code(kind="device")` shows the card.
2. "Set up waking for the Dell." `machine_configure(lifecycle="wake_on_lan")`. She states the derived MACs, relay, and gateway-MAC match, then "Not verified: no wake measured."
3. Dell asleep. "Is it asleep?" `machine_status` answers per the P0-2 branch.
4. "Wake it." Progress lines, then the measured seconds.
5. Chat link 1 is `dell:…`. "hi" shows "Waking the Dell… answering 19 s… loading… ready 41 s", then the answer. Read `llm_call.meta.served_on`, the `wake` span, and the attempt row with outcome `ready`.
6. Set the ceiling to 30 s and turn off Wake on Magic Packet. The route frame names link 2: "dell did not answer within 30 s of the wake sent …". The row is `no_answer`. With a single-link chain, a stated failure.
7. Unattended wake, then a 3-minute answer: not interrupted. After lease plus idle, the Dell sleeps on its own.
8. Overnight: no urgent push.
9. Checked at 393 px.

### S44: thin clients

- `OpenElsewhere.tsx`, first on the Devices tab and linked from the `Ready` step. It shows a QR code of `tailnet_origin` via a pinned `uqr` dependency rendered as inline SVG. It never encodes loopback.
- Per-platform steps:
  - iOS: Safari → Share → Add to Home Screen, "Open as Web App" on.
  - Android: Chrome ⋮ → Install app; Firefox ⋮ → Install.
  - Desktop Chrome/Edge: install from the menu.
  - Desktop Firefox: bookmark only.
  - Prerequisite: Tailscale signed in on the same tailnet.
- Tool `nova_address()`: `reads_only` True, `AUTO_RUN`, facts `{"nova_address","observed_at"}`.
- Guard `address_claim`: a `https://*.ts.net` in the reply that is neither the observed origin nor an engine `base_url`.
- One capability phrase.
- Eval `gives-the-real-address-for-another-device`. Suite → 18, registry 44 → 45, `test_live_facts` +1, `tabs.test.tsx`.
- **DoD**: "How do I put you on my tablet?" She calls `nova_address` and gives the steps. A second phone scans the QR and installs. Checked at 393 px.

---

## 5. Completeness pass

**Still not covered**

- **Other platforms**
  - macOS nodes: Docker Desktop on a Mac has no GPU. B2's external-ollama seam would cover it; it is built only if P0-4 fails.
  - Windows or macOS relays: novad is Linux-only (`README.md:33`).
  - Two engines on one machine.
  - Web push on thin clients: there is no service worker.
- **Hub resilience**: the hub is Wi-Fi-only (`wlo1`), so a Wi-Fi drop takes Nova offline. RAM headroom with minecraft is measured in P0-9 but not mitigated.
- **Outbound proxy exposure**: the hub sidecar's outbound proxy is reachable from every compose container. The compose test only pins that just the gateway is configured with it; tailnet ACLs are recommended in the docs.
- **Unverified claims, each assigned to a check**:

  | Claim | Where it gets checked |
  |---|---|
  | `SetThreadExecutionState` from a user-session helper holds a machine that woke unattended | P0-5 |
  | Docker Desktop publishes `127.0.0.1:11436` on Windows loopback | Proven at install by the helper's first report, otherwise stated |
  | httpcore CONNECT timeouts behave as the critique says | Made moot by `asyncio.timeout` |
  | SSE passes through `TS_OUTBOUND_HTTP_PROXY_LISTEN` | P0-7 |
  | Wi-Fi 7 multi-link operation (MLO) works with WoWLAN | P0-1 |

- **Collisions with doing-things** (branch `claude/nova-autonomous-capabilities-c25b5c`, which is unmerged):
  - Core migrations 035–037 against its 035.
  - S29 deletes `_KIND_TOOLS` in favour of `Tool.backs`, and adds its own stack_claim probe exemption.
  - S30 adds `build` to the auth frame (merge it with `facts`), re-points daemons at `:8000`, and derives the stack host from `NOVA_STACK_HOSTNAME`, which changes at the move.
  - S31 builds novad in core; `./install novad` should reuse it.
  - The registry and suite-version pins collide.
  - Rule: whichever lands second renumbers and re-bumps once.
- **Scheduler contention**: its firings do not read `person_busy`, so they can contend with the owner for the Dell's card. That stays "state, never decide", and it is not addressed here.

**Owner questions** (short; 2–4 are asked only if the measurement triggers them)

1. **Numbering and order.** S40–S44 (with S42a/S42b), leaving S38 and S39 to doing-things' substrate range. Where does this sit relative to item 0, S26 and Proposal A?
2. **If P0-1 gives W2 or W3.** Accept a stated cloud fallback while the Dell sleeps, keep the Dell awake, or change its hibernate or sleep timer. It is his machine; Nova only states the numbers.
3. **If P0-6 confirms Docker Desktop starts only at sign-in.** Accept "after a Windows restart the Dell serves models only once you sign in", or enable automatic sign-in.
4. **If P0-7 finds no tailnet path with ProtonVPN up.** Split-tunnel Tailscale in ProtonVPN, or pause ProtonVPN.

### Critical files for implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/routing.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/data_plane.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/chat.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh