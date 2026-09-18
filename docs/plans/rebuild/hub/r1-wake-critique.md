# Adversarial review: Wake and Hold (hub topology)

I checked every claim below against the worktree, read-only. On the Dell's own WSL I also ran read-only inspections (`ip -br link`, sysfs, `/proc/<novad>/environ`, `/etc/wsl.conf`, routes). Those results are marked **[measured]**.

## Ranked findings

### 1. CRITICAL: the hold is taken after the window where sleep can interrupt an answer (breaks decision 2)
- **Defect.** The hold is renewed only when `x-nova-served-by` names a node engine, and it is awaited "before the span closes".
- **Why that is too late.** The gateway sends response headers only after the upstream model has loaded and finished prefill.
  - `served_by` is read from the response headers at `services/core/app/chat.py:2645`.
  - The measured "headers after 280 s" note is at `chat.py:2610`.
- **Scenario.** The Dell is awake but not held: either a user woke it, or the 10-minute lease ran out, and Windows' own idle count then restarted. The idle timer is 29 of 30 minutes in when a turn begins. The 27B model loads for 40 s and Windows suspends mid-load. The round then hangs until the 300 s read timeout (`GATEWAY_TIMEOUT`, `chat.py:143`). This is exactly the "doze mid-answer" that decision 2 forbids.
- **Fix.** Take the hold before the POST (D1).

### 2. CRITICAL: the turn path never learns that wakes do not land, and the rate limit does nothing
- **The rate limit is a no-op.** It is `started_at > now() - 120 s AND outcome <> 'ready'`. The deadline is 120 s with no history and up to 180 s at the ceiling. So by the time an attempt settles as `timeout`, its `started_at` is already outside the window.
- **Consequence.** Every turn that arrives after a failed wake starts a fresh wake and waits a full deadline.
- **Why this is likely.** Decision 7 makes a Wi-Fi wake that never lands a real possibility; so do a hibernated Dell and a Dell whose Docker Desktop has not started (finding 11). In any of those cases each chat turn spaced more than 2 minutes apart costs 120–180 s before link 2 answers, indefinitely.
- **Fix.** Measure the window from `settled_at`. Add a derived, stated rule for the turn path: send the packet but do not wait (D2).

### 3. MAJOR: the rate limit also applies to her explicit `machine_wake` (a refusal on the owner's behalf)
- **Defect.** `wake_engine` carries the rate limit, and it serves `trigger IN ('turn','tool','api')`.
- **Scenario.** "Wake it again" 60 s after a failed wake is refused by policy. That is a "may not", not a "cannot", which breaks the no-approvals ruling (`tests/test_no_approvals.py:1-10`: "nothing refuses on his behalf").
- **Fix.** The rate limit and the no-wait rule apply to `trigger='turn'` only. The tool and the API always send, or join the attempt already in flight.

### 4. MAJOR: novad's reconnect, the design's wake signal, is slow or can stall
- **The backoff never resets.** In `apps/novad/internal/client/client.go:119-135`, `attempt` is set to 0 once and incremented forever. After four disconnects in the daemon's lifetime, every reconnect waits 30 s. A node that sleeps nightly hits this within days, adding up to 30 s to every measured "novad back".
- **novad cannot notice a dead socket.**
  - There is no ping and no read deadline (`client.go:244-281`).
  - A dead socket is found only when a heartbeat write, sent at most every 20 s, draws an RST.
  - If the return path drops packets instead of resetting (for example the ProtonVPN tunnel still reconnecting after resume), the read can block until TCP retransmission gives up, which takes minutes. The wake then times out while the Dell is awake.
- **Fix.** See D3.

### 5. MAJOR: "connected" is not "awake", and "asleep" cannot be observed
- **The socket stays registered after sleep.**
  - `Hub.is_connected` is only membership in `_conns` (`services/core/app/devices_ws.py:167-168`). It clears only when uvicorn's ping times out: default 20 s interval plus 20 s timeout (**[measured]** in the installed `uvicorn/config.py`).
  - For up to about 40 s after the Dell sleeps, "Already awake: no packet sent" and `awake: true` are false.
- **A wait on "connected" can return early.** An Event set by `register` (`:148`) would return at once on that stale socket. "novad back" must mean a registration newer than the first packet.
- **Unverified negative claims.**
  - `awake: false`, the outcome name `timeout`, and the route reason "dell did not wake within 30 s" (walk step 5) all assert a sleep state the hub never observed.
  - The Dell may have woken with Docker Desktop or WSL down, or with the tailnet blocked. Only "did not answer" was checked.

### 6. MAJOR: walls recorded by header-less rounds break the next wake
- **How a header-less round walls the node.**
  - `_collect_completion` (judge and redirect rounds) sends `turn.role or "judge"` with no wake header (`chat.py:2959`).
  - Under G4, a round without the header keeps today's walk-on behaviour.
  - `serve_by_role` walls on any 5xx, which includes the 502 raised on a connect failure (`services/gateway/app/data_plane.py:112-125`).
  - Walls escalate 60 s → 5 min → 30 min (`routing.py:66`).
  - `note_success` never clears local walls (`data_plane.py:130-131`).
- **Consequence.** The next chat round finds the node link walled, not asleep. The gateway skips it instead of returning the asleep refusal, and no wake happens.
- **Fix.** G4 must be independent of the header: a connect-phase failure on a `node` engine never records a wall, for any caller. The header decides only whether the gateway returns 503-asleep or walks on.

### 7. MAJOR: "ready" is not verified, and wakes and fallbacks change what measurements mean
- **A model on the CPU would be reported as ready.** Nothing checks that CUDA survived the resume. A 27B model loaded on the CPU would be recorded as `ready`.
- **Fallback speeds are filed under the requested model.**
  - `model_speed` keys rates on `meta->>'model'`, which is the requested model (`services/core/app/model_speed.py:140-147`).
  - Once fallback is routine (every sleep), speeds from the N150 or the cloud get filed under `dell:qwen3.8:27b`. That is the "3090 number read as the N150's" rail, inverted.
- **The wake time lands in prefill.** The retry happens inside the same `llm_call` span, so `prefill_ms = t_first_any - t0` (`chat.py:2859`) includes the wake.

### 8. MAJOR: the narration guard would correct honest replies
- **Substring mismatch.** `_backed` checks whether the claim's target is a substring of the span's target (`services/core/app/guards.py:894-906`). "I woke the Dell" gives the target `"the dell"`, and `args.machine` is `"dell"`, so the claim reads as unbacked. That is a false correction, which the codebase calls worse than the lie (`guards.py:79-86`).
- **"powered on" and "turned on" are not anchored.** "I turned on the reminder" becomes a `woke_machine` claim.
  - The model-claim regexes anchor on a model-ref shape (`guards.py:122-135`).
  - `narration_check(reply, spans)` receives no machine names (`:909`).
- **Changing `_successful` has wider effects.** It also feeds `ran_a_tool` and `successful_tool_names` (`:841-868`), so adding wake spans there would change the bare-intent redirect.

### 9. MAJOR: rule 2 of the stack-claim carve-out reopens the 2026-09-12 failure
- Rule 2 exempts "the model / ollama / inference is down" whenever any node-not-answering evidence exists this turn.
- After a timed-out wake, "the model is down, I can't do that", said while the fallback model is answering, is exactly the claim the guard exists to correct (`guards.py:4616-4636`).
- Keep rule 1 only: the clause must name a node alias.

### 10. MAJOR: the eval plant's scope is wrong
- **Live turns can see the fixture.** Evals run inside the live core process (`evals/runner.py:921,1037`). A module-global `use_plant` swap would let the owner's concurrent chat see the fixture machines.
- **Real node models become ungradeable.** "FixturePlant replaces node listing" means an eval of a `dell:` model while the Dell sleeps cannot wake it, so every such run is UNGRADEABLE.
- **Case 1 would pass for the wrong reason.** `_state_claim_names` reads the database, where `eval_node` does not exist. So `guard_absent state_claim` would pass because the guard is silent by construction. The runner's own rule calls that worse than no case (`runner.py:26-37`).

### 11. MAJOR: the Dell runs Docker Desktop, not "WSL docker" [measured]
- **Evidence.** `docker` resolves to `/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker`, and there is no `dockerd`. So ollama runs in Docker Desktop's VM, while novad runs as a systemd user unit in `Ubuntu-26.04` (**[measured]**, pid 441).
- **Consequences.**
  1. ollama and novad have separate lifetimes, so "novad back" does not mean "engine back".
  2. Docker Desktop starts at Windows **login**. After a Windows Update reboot the node never answers until someone logs in, and each such episode feeds finding 2.
  3. Published ports bind on the Windows host. The open question becomes a Windows Defender rule on the Tailscale interface, not mirrored networking plus the Hyper-V firewall.
  4. CUDA after resume must be measured in the `docker-desktop` VM.
- **M6 targets the wrong thing.**

### 12. MAJOR: relay and MAC derivation are too weak
- **Subnet equality does not prove the same LAN.** `192.168.0.0/24` is ubiquitous; a laptop novad on any other network "qualifies". The relay then sends into the wrong LAN, and the record says "via laptop".
- **The Wi-Fi adapter has more than one MAC [measured].** The BE200 shows `<dell-wifi-mac>` (UP) and `<dell-wifi-mac-2>` (DOWN), consistent with Wi-Fi 7 multi-link, plus the locally-administered `<dell-wifi-mac-local-admin>`. Picking one MAC is a guess.
- **Nothing attributes the wake.** A power-button press, or a pattern-match wake caused by tailnet traffic, would be recorded as a Wi-Fi wake that landed. The measurement rows would then change meaning.

### 13. MAJOR: the measurement plan misses the likely failure causes
Missing from M1–M11:
- **BIOS.** The Dell BIOS setting "Wake on LAN/WLAN" (commonly Disabled) and "Deep Sleep Control".
- **Group-key rekey.** A station in WoWLAN that cannot offload the group-key rekey can no longer decrypt **broadcast** after the AP rekeys, typically every hour. M1's five quick trials would pass, and overnight wakes would fail.
- **Spurious wakes from pattern match.** Check for Tailscale disco/keepalive traffic waking the Dell (Windows event log, Power-Troubleshooter event 1, source).
- **Wake source.** Record `powercfg /lastwake` per trial.
- **Clock drift of Docker Desktop's VM after resume.**
- **Reconnect time with the backoff fix.**

### 14. MAJOR: pinned tests the design says stay unchanged will break
- **The `stack_ollama` and `stack_chat_model` tests.**
  - Selecting `kind == "hub"` in `_ollama_source` breaks the existing tests. Their fixture source is `{"key": "ollama", "ok": …}` with no `kind` (`services/core/tests/test_checks.py:93`, used at `:547-578`).
  - "No hub source means return []" reads a missing source as all clear. That contradicts `CannotCheck`'s doctrine (`services/core/app/checks/__init__.py:70-79`).
- **`chat_model` against a cached list.** Comparing chat.model with the node's last-known list and returning `[]` is also "all clear" from stale evidence.

### 15. MINOR: `_WAKE_MACHINE` should not go in `_DEFERRAL_TOOLS`
- That tuple routes to `_deferral_redirect`, which calls `_collect_completion` with **no tools advertised** (`chat.py:3120-3165`; the rule is stated at `guards.py:1908-1919`). She could not call `machine_wake` there.
- Add the class to `_OFFER_CLASSES` only.

### 16. MINOR: the Linux-side facts are wrong under mirrored WSL [measured]
- **Interface kinds are wrong.** Every interface is `hv_netvsc` with no `/wireless`, so Wi-Fi `eth3` classifies as "ether".
- **Tunnels have MACs.** Tailscale (`eth1`, <dell-tailnet-ip>, `<hyperv-vnic-mac>`) and ProtonVPN (`eth5`, 10.2.0.2, `<hyperv-vnic-mac>`) both carry MACs, so "tunnel = no MAC" never fires.
- **The default route is the ProtonVPN tunnel** (metric 1).
- **`powershell.exe` is not on the unit's PATH.** novad's `PATH` (`/proc/441/environ`) has no `/mnt/c`, and `WSL_INTEROP` is unset. So a "resolvable powershell.exe" check fails under the unit even though it resolves in a login shell.

### 17. MINOR: holder mechanics
- **Cold starts.** A fresh `powershell.exe` plus an `Add-Type` compile on every renewal is a cold start each time. Right after resume, when the machine is contended, it can exceed the 10 s "held" bound and produce a false "hold failed".
- **Clock skew.** `held_until`/`hold_until` as a device epoch is wrong under post-resume clock skew (M11).
- **Audit noise.** Each renewal is also a device audit-chain entry.

### 18. MINOR: a unicast "sent" may never leave the relay
- A unicast to `.140` is "sent" as soon as the kernel queues it. With no ARP answer from a sleeping NIC, it is dropped on the relay host.
- Report the neighbour-table state instead of `sent`.

### 19. MINOR: collisions with the unmerged doing-things S30
- S30 also adds `build` to the auth frame, turns `Dispatch` into a table, adds `devices.daemon_build`, and claims migration 035 (branch `claude/nova-autonomous-capabilities-c25b5c`, `doing-things.md:325-336`).
- `facts.novad` is meaningless until the ldflags stamp: `main.go:32-33` sets it to `"0.1.0-dev"`.

### 20. MINOR: the data model stores values it says it derives
- **Stale device reference.** `inference_nodes.device_id` is stored, but the design claims to derive it. A re-pair (for example `--force` after migration) creates a new device row, so the stored id points at a revoked row.
- **Keyed by engine, not machine.** Single-flight and hold are keyed by engine, so two engines on one machine wake it twice and hold it twice.

### 21. MINOR: polling a sleeping node
- **The late-landing watcher probes for 10 minutes.** It hits a node whose novad is disconnected. If pattern-match wake is on, the probe itself wakes the Dell and the row records a "late landing". Late detection can be event-driven via `Hub.register`.
- **Hibernation.** A node silent longer than its measured `hibernate_after_s` cannot be woken over Wi-Fi. Waiting on it is guaranteed waste.

### 22. MINOR: rails and docs are not addressed
- **Tailnet-only rail.** The LAN UDP magic packet needs an explicit statement against S5b's "tailnet only" rail: outbound only, no bind or listen, fixed payload.
- **Engine lifecycle.** Machine power is not engine lifecycle, and the locked rule says the gateway owns engine lifecycle. Say why core owns the wake: star topology, only core signs envelopes.
- **Docs.** User docs for the Windows and BIOS prerequisites are missing.
- **Citation.** `_run_turn` is defined at `chat.py:3553`; `:4016` is the call site.

### 23. MINOR: more than one sleeping node in a chain
- After one engine's deadline, the retry drops the wake header. A second node engine in the chain is then never woken.
- Alternatively, if the header were kept, the waits would add up. The turn needs a single wait budget.

## What survives unchanged
- **Relay through a paired novad.** A typed `net.wake` with a fixed 102-byte payload, ports 7/9 only, a result that reports *sent* and never *woke*, and the hub's own host novad as the default relay (decision 6). Go sets SO_BROADCAST on UDP sockets by default, and the Linux lookup for a limited broadcast from a bound source address picks the source's device. Both claims are correct.
- **Decision 8.** No SSH keys and no secrets manager. Authority is the ed25519 pairing with core's key pinned (`services/core/app/devices.py:9-14`, `envelope.go:141-209`). A MAC is not a secret. The ollama bearer token belongs to the engines area.
- **The lease-based `power.hold` on the node's novad.** Extend, never shorten. Nova never releases it. A child process that outlives the 110 s `cmdCtx` (`client.go:32,308`).
- **`wake_attempts` as durable rows.** SQL clock, a partial unique index for single-flight, and `settle_interrupted` beside `scheduler.sweep_orphaned_firings` (`services/core/app/main.py:92`).
- **The asleep/skip seam.** Core catches a typed asleep refusal (G4) and retries once with a skip (G5). The stated route frame is reused (`chat.py:3955-3980`). `_collect_completion` never wakes anything.
- **Facts in the auth frame**, additive under the unknown-keys contract (`devices_ws.py:52-67`). Windows host facts arrive in a separate frame after `ready`, and the Windows adapter list is treated as the truth.
- **The three tools** with their reads_only and ephemeral split. `machine_status` in `AUTO_RUN` (it is derived; `tests/test_live_facts.py:33-46` needs no pin change). A non-urgent `checks/machines.py`, so the urgent set is unchanged. The registry, capability and eval-corpus pin moves as listed.
- **The `facts` column** does not redden `test_no_approvals.py:270-295`. Nothing new is awaited in `_run_tool` or `_dispatch_calls`.
- M1–M11 as a base, extended below.

## Corrected design deltas

**D1. Hold before the round** (fixes 1 and 17)
- **Setting.** New setting `machines.hold_lease_s`: int, default 600, validated 300–1800.
- **`holds.ensure(turn, role, model)`** runs in `_gateway_round` **before** the POST.
- **Candidate engines.**
  - Engines of `kind=node` (G1) among the links of the role's chain, read from `/admin/routes` with a 30 s cache in core.
  - With no role, the engine of the explicit model.
  - A candidate must have a **fresh** novad (D4).
- **When to renew.** If `hold_remaining_s < GATEWAY_TIMEOUT.read + 60`, send `power.hold {seconds: lease}` with a 5 s bound, and write a `hold` span `{engine, ok, held_for_s | error}`.
- **Failure.** A failed hold never blocks the round. The span and `machine_status` state it.
- **Drop the post-round touch.** Remove the served_by-triggered awaited touch.
- **Relative times.** Heartbeats and `power.hold` report `held_for_s` (relative), never an epoch.
- **Windows mechanism: one long-lived PowerShell holder per novad process.**
  - Started at novad start, so it survives S3 and is ready at resume.
  - Driven over stdin: `hold N` → `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` plus an internal expiry timer → `ES_CONTINUOUS`.
  - Replies `held N`.
  - Stdin EOF → exit, which releases the hold.
  - Path: the absolute interop path `<automount root>c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, with the root read from `/etc/wsl.conf` (default `/mnt/`). No PATH lookup.

**D2. The turn path remembers wakes that do not land** (fixes 2 and 3)
- **Rate limit.** `trigger='turn' AND outcome IN ('no_answer','send_failed','cannot_send') AND settled_at > now() - interval '120 s'`.
- **No-wait rule** (turn path only, derived, stated):
  - **Trigger:** the last 3 settled attempts for the same `(machine, macs, relay)` are all `no_answer` or `send_failed`, with no `ready` or `late` after them.
  - **Action:** send the packet (it costs nothing), mark the row `not_waited`, and retry immediately with the skip.
  - **Route reason:** "the last 3 wakes of dell got no answer (latest 14:06); sent another, not waiting".
  - **Hibernation variant:** `now - node.last_seen > host_facts.hibernate_after_s`, with reason "asleep longer than its 3 h hibernate timer; Wi-Fi cannot wake a hibernated machine".
  - **Cleared by** any `ready`/`late` row, or by a novad reconnect.
- **The tool and the API never hit either rule.**

**D3. Connection liveness in novad** (fixes 4)
- **`Run`: reset the backoff.** Set `attempt = 0` whenever `connectOnce` returns after a handshake that succeeded. Test in `client_test.go`.
- **`heartbeat`: ping after each write.** After each heartbeat write, call `c.Ping(ctx)` with a 10 s timeout. On error, cancel `serveCtx` so `serve` returns and the daemon reconnects.
- **Resume detector.** On each tick, if the wall clock advanced more than 2 × `HeartbeatInterval`, close and reconnect at once.
- **Core side.** `Hub` records `last_frame_at` per connection and exposes `is_fresh(did, max_age_s=30)`.

**D4. Awake evidence and wording** (fixes 5)
- **Awake** = registered AND `is_fresh`.
- **"novad back"** = `connected_since > attempt.started_at`.
- **Facts.** `{"machine", "answering": bool, "novad_heard_s": int|null}`. Never assert `awake: false`.
- **Outcomes.** Rename `timeout` to `no_answer`.
- **Wording.** Reasons say what was checked: "dell's engine did not answer within 30 s of the wake packet sent 14:06:02 via azw-mini-s". Never "did not wake".
- **State-claim guard.** The widened state words stay, and the evidence is the `answering` or `connected` fact.

**D5. Verify the GPU and keep measurement meaning** (fixes 7)
- **Ready requires the GPU.** A wake is `ready` only when G3's load answer has `size_vram_bytes > 0`.
  - Otherwise the outcome is `ready_cpu`, stated as "loaded on the CPU (0 of N GB in VRAM); CUDA did not come back after resume".
  - The turn path treats `ready_cpu` as not ready and skips with that reason.
  - Requires G3 to return `size_bytes` and `size_vram_bytes`.
- **Split the spans.** The refused attempt closes its own `llm_call` span (`gateway_status` 503, `meta.asleep`). Then comes the `wake` span. The retry opens a **new** `llm_call` span with its own `t0`.
- **Key speeds on the server that answered.** `model_speed._RATES_SQL` and the stalls query key on `coalesce(meta->>'served_by', meta->>'model')`. Add a `test_model_speed` case.
- **New `wake_attempts` columns.**
  - `asleep_for_s` (now minus the node's `last_seen` at start).
  - `wake_source` (host facts `powercfg /lastwake` after reconnect).
- **Stats.** The deadline and the landing counts read only rows whose `wake_source` is a wake-armed adapter of that node. Other rows are stated as "woken by <source>, not by the packet".
- **Outcome CHECK.** Add `ready_cpu`, `no_answer`, `not_waited`.

**D6. Guards** (fixes 8, 9, 15)
- **Narration check.**
  - New signature: `narration_check(reply, spans, machine_names=())`.
  - `_WOKE_MACHINE` is anchored on the derived aliases: `\bI(?:'ve|\s+have|\s+just)?\s+(?:just\s+)?(?:woke|woken|powered\s+on|turned\s+on)\s+(?:up\s+)?(?:the\s+)?(?P<ref>{aliases})\b`. It is silent when there are no aliases.
  - `_target_of('machine_wake')` returns the machine's alias set (engine, device name, hostname).
  - `_backed` compares normalized alias sets for this kind.
  - `wake` spans with outcome `ready` back the claim inside `narration_check` only. `_successful` is unchanged.
- **Stack-claim carve-out:** rule 1 only.
- **`_WAKE_MACHINE`** goes in `_OFFER_CLASSES` only.

**D7. Eval seam** (fixes 10)
- `wake.PLANT: ContextVar[Plant]`, set with a token inside `run_case`'s task.
- `FixturePlant` **overlays** only names with the `eval_` prefix (the loader refuses any other) and delegates everything else to the real plant. So a real `dell:` model can still be woken for a measurement.
- `_state_claim_names` and `engines_not_answering` read names through the plant.

**D8. Relay and MAC derivation** (fixes 12)
- **Facts add the default gateway's `{ip, mac}`.** On Linux from `/proc/net/arp`. On Windows from `Get-NetNeighbor` for the default-gateway IP.
- **Host facts add** `Get-NetAdapterPowerManagement` (WakeOnMagicPacket, WakeOnPattern, ArpOffload), `powercfg /lastwake` and `powercfg /a`.
- **Relay candidate.**
  - A connected novad with an interface in the node's subnet **and** the same gateway MAC.
  - A subnet-only match is stated as "unverified L2".
- **MACs.** Send every MAC of the wake-armed physical adapter (all addresses without the locally-administered bit, e.g. `:55` and `:56`), capped at 4.
- **Unicast.** The `net.wake` result reports the relay's neighbour state for `unicast_ip` (`REACHABLE|STALE|INCOMPLETE|FAILED`) instead of a bare `sent`.

**D9. Walls** (fixes 6)
- G4 becomes: a connect-phase failure on a `node` engine **never records a wall**, whatever headers the request carries.
- `X-Nova-Wake` only chooses between the 503-asleep refusal and walking on with a stated reason.

**D10. Data model**
- Rename `inference_nodes` to `machines(engine PK, mac_override macaddr[], relay_override uuid, device_override uuid)`.
- The node device, MACs and relay are derived per use from live facts, with overrides reported as "owner-stated".
- Single-flight and hold keys are the node device, or the MAC set when there is no novad.
- Use `macaddr[]` in both tables.
- Take the migration number at merge after doing-things (035 or later), and merge the auth `facts` object with S30's `build`.

**D11. Checks** (fixes 14)
- **Moved tests.** `test_checks.py:93,547-578` move with a stated reason (sources gain `kind`).
- **No hub source.** When the gateway does not *state* "no hub engine", raise `CannotCheck`, not `[]`.
- **`chat_model` against a node that is not answering** raises `CannotCheck("dell is not answering; chat.model was last confirmed present at <as_of>")`. Never `[]`.

**D12. Late landings and probing** (fixes 21)
- For nodes with a novad, the late landing is event-driven: the first registration after a `no_answer` sets `late` with `device_back_s`.
- The engine is never probed before novad is back.
- Polling, at most every 15 s for 10 minutes, applies only to nodes with no novad, and is stated as "polling may itself wake a pattern-match-armed node".

**D13. Cuts (YAGNI)**
- Replace the SSE `POST /machines/{engine}/wake` with a plain POST that returns 202 and the attempt id. The card polls `GET /wakes`.
- Fold `X-Nova-Skip-Reason` into `X-Nova-Skip-Engine: dell; reason=…`.
- Drop the Linux sysfs `kind` classification (Windows facts are the truth under WSL; on native Linux, `/wireless` suffices).
- Use one wait budget per turn: at most `wake_max_wait_s` in total, and later node links are used only if they are already answering.

**D14. Measurements added before building**
- **M1 extended.** Record the BIOS "Wake on LAN/WLAN" and "Deep Sleep" settings, and the `Get-NetAdapterPowerManagement` output. Run trials at 5 min, 90 min (past the group-key rekey) and overnight. Log `powercfg /lastwake` for every trial.
- **M2 extended.** Leave the Dell asleep for 2 h with the tailnet peers up, and count spurious wakes from event-log wake sources.
- **M6 replaced.** When do Docker Desktop and the Ubuntu distro start after a reboot with no login? Do they survive S3? Is the `docker-desktop` VM's clock right after resume?
- **M12. ProtonVPN.** Run `curl https://nova.tailba0abb.ts.net/healthz` from WSL right after resume, with the kill switch in its current setting.
- **M13. Reconnect time.** Resume-to-`ready` for novad, measured with the D3 fix in place (journal timestamps).

**D15. Docs and rails**
- A `deploy/README.md` section and a user doc for the Dell prerequisites: BIOS, adapter power management, "Only allow a magic packet", sleep and hibernate timers, Docker Desktop at login.
- One paragraph stating the LAN-UDP carve-out, and why machine power sits in core rather than in the gateway's engine lifecycle.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/chat.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_ws.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/data_plane.py