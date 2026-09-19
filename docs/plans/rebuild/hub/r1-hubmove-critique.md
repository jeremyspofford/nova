# Adversarial review: Area C (hub move and setup surfaces)

I checked every claim below against the worktree, read-only. Line numbers refer to the current HEAD, `0531b496`.

## Ranked findings

### CRITICAL

**C1. The wake test can report success while the node is unusable. This breaks "never report success you did not check".**

The test's success chain ends at "engine answering → CUDA confirmed → lastwake credits the adapter". Two things are not checked:

- **Windows goes back to sleep.** After a wake that did not come from the user, Windows applies the hidden *System unattended sleep timeout*, which defaults to about 2 minutes. It sleeps again unless something holds a Windows power request. A "✓ measured wake" would be followed by the Dell sleeping in the middle of the next answer, which is exactly what owner decision 2 forbids. Nothing in the test checks that B's hold actually works.
- **"CUDA confirmed" reads a stale fact.** It reads ollama's `library=` line. That line is logged once, when the process starts ("the one from the most recent start", `deploy/install.sh:726-737`). An S3 resume does not restart ollama, so after a wake the line describes the GPU as it was before sleep. CUDA failing after resume in WSL2 is exactly the case it cannot see.

**Fix.** A wake passes only if all three hold:
1. A 1-token generation on the target model after the wake, then `/api/ps` shows `size_vram == size`.
2. The engine still answers at wake + max(UNATTENDSLEEP read by `powercfg /qh`, 120 s) + 30 s, while B's hold is active.
3. `powercfg /requests`, read through the fixed argv set, shows the hold.

Add measurements M13 and M14 (listed in the deltas).

**C2. The move creates a false URGENT push every night.**

- Step C8 sets `chat.model=dell:qwen3.8:27b`.
- When the Dell sleeps, its rows leave the catalogue. `stack.chat_model` (`services/core/app/checks/stack.py:264-331`) finds no row.
- It then consults `_ollama_source` (`:208-214`), which is the hub's builtin ollama (`LOCAL_PROVIDER="ollama"`, `:50`). That answers ok, so the check emits `chat_model_missing:dell:…`.
- That finding belongs to the only urgent family (`stack.py:337-355`; pinned by `test_checks.py`).

This breaks "the hub stays healthy while a node sleeps" and "state, never decide". The design's interface list does not ask A for this, and C8 does not wait on it.

**Fix.** Add a new interface A5: the catalogue keeps a sleeping node's last-known rows with `state=asleep`, and `chat_model` treats asleep as distinct from missing. Add a test, and make C8 wait on A5.

### MAJOR

**M1. `restore` on the mini PC fails on the subnet collision.**

- `cmd_restore` step 6 runs `up -d postgres`. That creates `nova_default` from `${NOVA_SUBNET:-172.18.0.0/16}`, because subnet keys are never carried.
- `decide_subnet` runs only inside `cmd_install` (`install.sh:1078-1089`).
- The drill in P3 uses `docker run`, so it passes. The real restore in C3 dies with a pool-overlap error.

**Fix.** `decide_subnet` must be the first step of `cmd_restore`.

**M2. The C6 command is broken.**

- nginx forwards `Host $host` (`apps/web/nginx.conf.template:425`), and nginx's `$host` drops the port.
- So `curl http://127.0.0.1:3000/.../install.sh` renders `HUB=http://127.0.0.1`, which is port 80, where nothing listens.

**Fix.** Stop rendering HUB from request headers. The printed command passes it explicitly: `… | bash -s -- --hub <origin> --code …`. The web page and the tool already know the origin. The script refuses to run without `--hub`.

**M3. The "two nodes, one identity" guard has three holes.**

- **(a)** `--move` stops only core, gateway, memory, web and tailscale. postgres, searxng and ollama keep running under `restart: unless-stopped` (`docker-compose.yml:6,172,209`).
- **(b)** `deploy/.moved` stops only `./install`. It does not stop:
  - a hand-run `docker compose up -d`;
  - `git clean` (the file is not gitignored);
  - doing-things S33 deploy-by-SHA.
- **(c)** The v3 copy of the same node key, the volume `nova_tailscale_state`, still exists on the Dell. The README migration *copied* it (`cp -a`, `deploy/README.md:196-198`); it did not move it.

**Fix.**
- After verification, `--move` runs `docker compose --profile '*' down`. This removes containers and keeps volumes.
- It writes `MOVED_TO=<hub>` *into* the Dell's `v4_tailscale` volume, and `deploy/tailscale/start.sh` refuses to start when that file is present. The refusal then lives at the layer that would cause the conflict.
- The runbook deletes `nova_tailscale_state` after the soak. It must never use `tailscale logout`, which would revoke the key the hub now uses.

**M4. Two ollama servers on one model store and one GPU.**

- At C7 the node package adopts `nova_v4_ollama`, but the old `nova-ollama-1` is still running with that volume, the GPU, and `127.0.0.1:11434` (see M3a).

**Fix.**
- Covered by the `down` in M3.
- The node installer also refuses to adopt a volume that a running container mounts (`docker ps --filter volume=`), and names that container.

**M5. The attach flow makes Jeremy operate a machine Nova can already reach.**

- DELL-XPS-8950 is paired, and paired devices have `shell.exec` and `fs.write` (`apps/novad/internal/caps/caps.go:45-66`).
- CLAUDE.md:148-155 says "Operating the running system is hers."
- The design still has the owner paste a curl line on the Dell. It also adds a public `/attach` route, a new canonical form for device-signed HTTP, the `attach-node` verb, and a code purpose. That is a second authentication scheme next to the WebSocket challenge.

**Fix.**
- Add a tool, `machine_attach(device, name)`. It registers the engine (A1), writes `node.env` through a signed `fs.write`, then runs `chmod 600` through fixed argv (`fs.go:87` writes 0644). It then runs `docker compose -p nova-node up -d` as fixed argv and reads the result back through the probe.
- Drop `/attach`, `attach-node`, and the attach code path. Keep curl|bash only for machines that are not paired.
- Risk: novad's 110 s command limit (`client.go:32`) versus image pulls. Pull in a separate call, or wait for S30's detached jobs.

**M6. The state guard does not cover the new claims, although the design says it does.**

- Changing `_DEVICE_SPAN_PREFIX` to a tuple does not guard "the Dell is asleep". `state_claim` subjects are paired device names or "the device" (`guards.py:2471-2476`).
- `_STATE_WORD` (`:2441-2445`) has no asleep, sleeping, awake or waking.
- "dell" is an engine name; the device is named "DELL-XPS-8950".

So the most common new state claim is neither caught nor backed. The comment at `:2415-2416` ("the prefix IS the derivation") would also become false.

**Fix.**
- Add `asleep|sleeping|awake|waking(?:\s+up)?|suspended|hibernating` to the state words.
- Subjects become the live device names plus the live engine names (from `GET /admin/engines`), each engine mapped to its device.
- Evidence is any span that carries a `{"engine","state"}` or `connected` fact.
- Add MUST_FIRE and MUST_NOT cases.

**M7. Measurements change meaning in core too, not just in the gateway.**

- `model_speed` groups by `meta->>'model'`, which is the *requested* model (`chat.py:2632-2633`; `model_speed.py:142-156`). Its 30-day baseline feeds `inference_degraded` on every beat.
- After the move, an `ollama:`/bare id resolves to the N150's builtin ollama and is compared against the 3090's history.
- Between C4 and C8, every role chain's `ollama:*` link also resolves to the N150.

**Fix.**
- A2 extends to core: key speed on the served engine (`served_by` is already on the span, `chat.py:2645-2647`), or cut a frame at the move.
- The move rewrites `chat.model` and every role-chain link from `ollama:*` to `dell:*`, with a read-back. That is a step before C8, not a manual chore.

**M8. Revoking a device does not cut its inference link.**

- The engine row and its bearer token live in the gateway. `revoke` only stamps `revoked_at`.
- A revoked machine keeps receiving routed conversations.

**Fix.** Revoke disables or deletes the engine for that `device_id` in the gateway, reads it back, and has a test.

**M9. Windows prerequisites the one-command flow cannot do, and none of them is measured.**

- **Hyper-V firewall.** In mirrored mode it blocks inbound traffic to WSL by default. Opening it needs an admin `Set-NetFirewallHyperVVMSetting` or `New-NetFirewallHyperVRule`.
- **WSL lifetime.** Does WSL stay up with no terminal open, and does it start after a reboot or logon? (Both are in the owner's UNKNOWN list; both are missing from M1–M10.)
- **Wake on Pattern Match.** If it is on, directed traffic can wake the Dell: tailnet or WireGuard UDP, and the hub's probes. The Dell may then never stay asleep, and `lastwake` would credit the adapter for a wake that was not a magic packet.

**Fix.**
- Add M11, M12 and M15.
- `machine_wake_check` also parses `WakeOnPattern` and `powercfg /qh … SUB_SLEEP` (UNATTENDSLEEP is a hidden setting).
- Add checklist items "hub → node inbound" and "WSL starts without a terminal".
- Nova states the admin steps as steps she cannot take herself.

**M10. novad's reconnect backoff never resets.**

- In `apps/novad/internal/client/client.go:119-135`, `attempt` only ever increments.
- From the fifth disconnect in a process's life, every reconnect waits 30 s. The heartbeat also ticks only 20 s after resume (`:36`).
- So novad comes back roughly 50 s after resume, not "+8.4 s". That skews the wake test, the relay's availability and the default deadlines.

**Fix.** Reset `attempt` after a successful handshake, with a test (B/novad). The wake test's readiness signal must be the engine, never novad.

**M11. The hub reaching the node needs Tailscale on the host itself.**

- The sidecar runs userspace and inbound-only (`docker-compose.yml:269-274`). The gateway reaches 100.x only through the hub host's own kernel Tailscale.
- Owner decision 6 ("we don't know other people's setups") means this cannot be assumed.

**Fix.**
- Add a derived checklist item: "hub reaches tailnet peers", from a probe.
- State it as a prerequisite of the fourth wizard option.

### MINOR

1. **Custody of the pairing code.** The plaintext code ends up in:
   - `turn_spans.meta.result_head` (`chat.py:2255`);
   - `messages`;
   - a cloud chat model's context, if chat runs on a cloud model.

   That contradicts `devices.py:16-17` and `:157-158` ("The plaintext exists in one HTTP response and nowhere else"). Either accept it and rewrite those docstrings with the reason (single use, 10 minutes), or redact the persisted `result_head` down to `code_id`.
2. **Row hashing hits a 1 GB limit.** `md5(string_agg(t::text …))` hits Postgres's 1 GB text limit on large tables. Use `md5(string_agg(md5(t::text),'' ORDER BY md5(t::text)))`.
3. **Carrying `.env` secrets is unnecessary.** The services read only DATABASE_URL, SERVICE_TOKEN, OLLAMA_URL, MEMORY_EMBED_*, MEMORY_ROOT and SEARXNG_URL. Nothing encrypts data with a key from env. Fresh secrets plus logical dumps work. Carry only `TAILNET_HOSTNAME`, plus `NOVA_PUBLIC_GATE_TOKEN` if it is set, so the MANIFEST holds no secrets.
4. **`tailnet_origin` needs provenance.** core:8000 is published on loopback (`docker-compose.yml:36`) and reachable from every container, so the header can be forged directly. That is the open S8 carry (`nginx.conf.template:76-78`). Upsert only when `request.client.host == NOVA_WEB_ADDR` (pass that to core's env). In the web page, prefer `window.location.origin` when it is an https `*.ts.net` origin.
5. **Open question 2 rests on a false premise.** `/api/` includes the gate check (`nginx.conf.template:419-420`), so a *gated* public origin never serves the bundle.
6. **`register_node` ordering.**
   - It must run last in the transaction, with a compensating delete if the commit fails. Otherwise the gateway keeps orphan engines for device ids that were rolled back.
   - Re-attaching must rotate the token.
   - Validate `machine_name` against the live provider names when the code is minted; otherwise a colliding name makes the code unusable.
7. **Pinned test.** `test_devices.py:526` pins `set(body) == {"code","expires_at"}`. Keep the devices route's shape.
8. **Second guard pipeline.** The regeneration re-check list (`chat.py:3281-3315`) must include `code_claim`, not only the `:4256-4410` site.
9. **Wrong exclusion reason.** The design's NOT_AUTO_RUN reason for `machine_wake_check` contradicts `live_facts.py:72-87`, which auto-runs reads of *paired* devices. Classify it AUTO_RUN, or give the true reason (the latency of several `powershell.exe` spawns).
10. **`ensure_embedder` checks presence, not function.** Verify with a real `/api/embed` that returns 768 dimensions, not `ollama list`.
11. **Pointless compose change.** Adding `MEMORY_EMBED_URL` to compose changes nothing: `DEFAULT_URL` is already that value (`embedding.py:75`).
12. **Subnet picker order.** It starts inside docker's default pool (172.17–172.31), so another project can take the range after a `down`. Try 10.200.x first. Exclude the test subnets:
    - 172.28 (`tests/e2e/docker-compose.isolated.yml:87`);
    - 172.29 (`deploy/tailscale/start_test.sh:44`);
    - 10.98.0 and 10.98.1 (`tailnet_topology_test.sh:45`).
13. **Linux `ethtool` needs root to read WoL.** It needs CAP_NET_ADMIN; say "cannot read without root".
14. **The wake-source rule gives false negatives.** WoWLAN often reports no named source. Report the facts (packet at T, engine at T+Δ, source X or "unnamed"). Fail only when Windows names a *different* source.
15. **Merge `machine_test_wake` into B's `machine_wake` with a measurement flag.**
    - Refuse with "cannot: it is awake" instead of waiting for the machine to go quiet.
    - Join B's single-flight so the test and a real wake are never two packets.
    - Sweep orphaned test rows at startup.
16. **The fourth wizard option needs the tailnet.**
    - With no tailnet origin, disable it with a stated reason.
    - Word it "on your tailnet".
    - The legacy `/admin/backend` view (`backends.py:30-38`) will still show "Bundled Ollama" as active.
17. **Firefox on Android can install PWAs.** Only desktop Firefox is bookmark-only.
18. **The routine backup mode overlaps Proposal D** (`ROADMAP.md:282-295`) with no schedule, no freshness check and no tool for her. Label it move tooling.
19. **`host_sees_node_online` must fail when it cannot check.** Today, "could not be made" lets the install continue. Make it refuse, with an explicit override flag.
20. **Engine `base_url` goes stale.** It is set once, from the first facts frame. Re-derive it on every facts frame.
21. **Collisions with doing-things.**
    - Registry 39 → 44 is also S30's move.
    - Migration 035 is also S30's.
    - S31 builds and signs novad in core. The bundle should reuse S31's signed manifest rather than duplicate it.
    - S30 re-points the stack-host daemon to `:8000` and takes the stack host from `NOVA_STACK_HOSTNAME`, which changes at the move.
22. **Housekeeping.**
    - `nova_v4_ollama` keeps the `nova` project label, so a later `compose -p nova down -v` deletes the 27B. Note it in the runbook.
    - Gitignore `.moved` and `.restored`.
    - The "why won't my PC wake" eval may call `machine_status` first. Name the machine in the message, or accept either tool.

## What survives unchanged

- **Backup approach:**
  - logical dumps per database with the container's own `pg_dump`;
  - a self-test restore into scratch databases;
  - a manifest with counts, md5s and the signing-key fingerprint;
  - sha256 listings per volume;
  - refusal on a non-empty target, and on a missing migration file;
  - the pg-major refusal;
  - the drill.
- **The list of what is not carried:** `v4_pgdata` raw, `v4_models`, `hardware.json`, `COMPOSE_FILE`, profiles, subnet keys, `TS_AUTHKEY`, searxng.
- **The subnet design:** the subnet is chosen, recorded, adopted if the network already exists, and the install dies naming the collider. Addresses are derived from it.
- **novad `repoint`** with the pinned-key check, and step P4 (re-point before the move so the Dell's novad follows the URL).
- **The answer to Jeremy's SSH/secrets question.** No SSH keys and no secrets manager. novad pairing gives each machine an ed25519 key. The hub mints the per-link bearer token. The magic packet needs no credential.
- **Relay and checklist:** the relay is a paired device on the node's subnet, derived from its facts. One `machines.checklist` serves all three surfaces.
- **The thin-client design:** the PWA from the tailnet URL, a QR code, per-platform steps, and no service worker.
- **Tools:** `machine_status`, `machine_configure` (with read-back), and `machine_wake_check` (fixed argv, parsed in code, stating what she cannot do).
- **Guards and pins:**
  - the narration kinds `woke_machine` and `configured_machine`;
  - the capability phrases;
  - `_SETUP_MACHINE`;
  - the eval corpus bump 13 → 14 and 23 → 25;
  - the migration number 035, with its collision noted.
- **Runbook shape:** a 7-day soak with rollback R1–R3, and "A2 before C1".
- **Open question 1** (slice numbering).

## Corrected design deltas

1. **Wake success (C1).** Success follows the three-part rule in C1. Every attempt records `{packet_at, engine_ready_s, size_vram_ok, held_past_unattend, wake_source}`.
2. **Interfaces added to A.**
   - **A5:** the catalogue keeps asleep rows, and `stack.chat_model` treats asleep as distinct from missing. C8 waits on it.
   - **A2+:** core's speed history is keyed by the served engine, or cut at the move.
   - A data step rewrites `chat.model` and the role chains from `ollama:` to `<node>:`, with a read-back.
   - Revoke cascades to the engine row and its token.
3. **Interfaces added to B.**
   - novad backoff reset.
   - A Windows power-request hold, readable through `powercfg /requests`.
   - The node compose file must not publish 11434 on loopback.
   - Single-flight wake with a join, used by the test.
   - The Hyper-V inbound rule, stated as a Windows admin step.
4. **`cmd_restore`.**
   - Order: `decide_subnet` → hash check → refusals → volumes → postgres → restore → verify.
   - It never applies secret env keys; the MANIFEST carries `env_key TAILNET_HOSTNAME` only.
5. **`--move`.**
   - Verify the backup, then `docker compose --profile '*' down` (no `-v`), then confirm nothing from project `nova` is still running.
   - Write `MOVED_TO` into `v4_tailscale`. `deploy/tailscale/start.sh` exits non-zero with "this node moved to <hub>" when that file is present, and `start_test.sh` covers it.
   - Keep `.moved` for the installer's own message.
   - Runbook: after the soak, delete `nova_tailscale_state`.
6. **The node command.** `curl -fsSL <origin>/api/v1/machines/node/install.sh | bash -s -- --hub <origin> --code <code>`. No header rendering; the script refuses without `--hub`.
7. **Tools (net +5, so 39 → 44, sequenced against S30's own move).** `machine_add_code` (unpaired machines only), `machine_attach` (paired devices, via signed `fs.write` and fixed argv), `machine_status`, `machine_configure`, `machine_wake_check`. Measurement becomes a flag on B's `machine_wake`. Drop `/api/v1/machines/attach` and `novad attach-node`.
8. **Guards.**
   - The state-word and engine-subject extension from M6.
   - `code_claim` wired at both sites. It compares against `facts_sink` `{"machine_code": code_id, "code_sha": …}` rather than `result_head`, which is redacted to `code_id` before it is persisted.
9. **`tailnet_origin`.** Add `NOVA_WEB_ADDR` to core's env. The identity hook upserts only when `request.client.host == NOVA_WEB_ADDR`, and the table's comment says so.
10. **`machine_wake_check` argv additions.** `powercfg /qh SCHEME_CURRENT SUB_SLEEP` and `powercfg /requests`. Parse `WakeOnPattern`. New blockers: "Wake on Pattern Match on: any packet to the Dell, including my own status checks over the tailnet, can wake it" and "unattended sleep N min". Classify the tool AUTO_RUN.
11. **Measurements to add before building.** Each is recorded in the slice doc and gates the design choice that rests on it:

    | ID | What to measure |
    |---|---|
    | M11 | WSL stays up with no terminal, and starts at boot or logon |
    | M12 | Mini PC → `<dell-tailnet-ip>:<gate>` reaches a port published from WSL docker (mirrored mode, Hyper-V firewall) |
    | M13 | Unattended re-sleep after a magic-packet wake, and whether a power request set through interop holds it |
    | M14 | CUDA after S3 resume: 1-token generation, then `size_vram` |
    | M15 | The Dell stays asleep for 1 h or more with the hub running its probes |
    | M16 | novad reconnect latency after resume |
    | M17 | `tailscale ping` from the hub to the Dell: direct or DERP, with ProtonVPN up |

12. **Checklist additions.**
    - The hub reaches tailnet peers.
    - Inbound from hub to node.
    - WSL starts without a terminal.
    - The hold is observed.
    - Wake on pattern match is off.
13. **Smaller fixes.**
    - Row-hash aggregation.
    - Subnet order starting at 10.200.x, excluding the test subnets.
    - Drop the `MEMORY_EMBED_URL` compose line.
    - `ensure_embedder` does a real embed.
    - Keep the devices mint response shape.
    - Rewrite open question 2.
    - Add the Firefox Android install steps.
    - Gitignore the marker files.
    - Coordinate with S31's signed novad manifest.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/tailscale/start.sh
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/checks/stack.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go