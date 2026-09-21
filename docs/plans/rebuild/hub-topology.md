**Status:** APPROVED by Jeremy 2026-09-18. Item 0 is done (the core suite runs to the end),
**S40 and S40b are shipped, deployed and walked** (2026-09-19), and **S41 is next**. Phase 0
is measured just before the slice each measurement gates.

**How this was made:** six code maps, then two design rounds. Each round had three designers,
one adversarial critic per design, and an integrator. Round 1 was designed for Jeremy's machines.
He rejected it as too rigid ("this will need to work on any os and device"), and round 2
redesigned it cross-platform. Where the two rounds conflict, **round 2 wins**. The full texts live
in `hub/`:

| File | What |
|---|---|
| `hub/map-*.md` | Read-only code maps with path:line (gateway inference, deploy/install, devices/clients, onboarding/tools/guards, v3 prior art, roadmap decisions) |
| `hub/r1-*-design.md`, `hub/r1-*-critique.md`, `hub/r1-integration.md` | Round 1 (single setup): engines, wake, hub move |
| `hub/r2-*-design.md`, `hub/r2-*-critique.md`, `hub/r2-integration.md` | Round 2 (any OS): agent, transport, slices. **`r2-integration.md` is the implementation reference.** |

MAC addresses and tailnet IPs are redacted (the repo is public).

---

# Nova hub: always-on hub, a Nova agent on every machine, per-machine local models, Wake-on-LAN, thin clients (any OS)

## Context

Today all of Nova v4 runs on the Dell (Windows 11 + WSL2 + Docker Desktop + RTX 3090). When
the Dell sleeps, Nova stops: no beats, no scheduled jobs, no chat from the phone. The roadmap
has carried this since S11 ("Where Nova runs is a bigger question than that slice").

Jeremy wants:
- an always-on **hub** that runs all of Nova;
- **local models on other machines**, which Nova wakes with WoL and uses once they're up;
- the hub optionally running models itself;
- **thin clients** that are UI only;
- setup through onboarding, Settings, and Nova walking the user through it.

It must work on **any OS and device mix**: Mac-only, several Macs, Linux, Windows with or
without WSL, or a combination. Nova should set up the networking between machines herself
(Tailscale first). Nothing may lock the design to his setup.

### Owner decisions (2026-09-18)

1. **Models on all machines at once.**
   - Ids name the machine (`hub:qwen3:8b`, `dell:qwen3.8:27b`).
   - Routing is per role, so background roles need not wake a node.
   - Each machine has a "this machine runs models" switch.
2. **Sleep.** A node's own OS timer sleeps it. Nova only **holds it awake while using it**.
3. **While waking.** The turn waits and shows progress. Past a deadline, the next routing-chain
   link answers and says so. With no next link, the turn fails and says why.
4. **Thin client** = the installable PWA plus an "Open on another device" screen.
5. **Migrate** Jeremy's current Nova from the Dell to his mini PC hub, with backup and restore both verified.
6. **WoL never assumes the hub is on the node's LAN.** The relay is any Nova agent on that LAN.
7. **Wi-Fi WoL is measured, never assumed.** The Dell stays on Wi-Fi.
8. **No SSH keys and no secrets manager** for reaching machines. Access is pairing (ed25519) plus a per-link bearer token.
9. **One Nova agent per machine.** `novad` grows into a native Go agent for macOS, Windows
   and Linux on amd64 and arm64. Its roles:
   - hands (the device tools);
   - models (fronts that machine's Ollama);
   - wake relay;
   - stay-awake hold;
   - facts.
10. **Transports.** Tailscale first, with Nova joining machines herself. Self-hosted
    **Headscale** and **plain LAN** follow, each with a seam built now. Plain LAN relaxes the
    "tailnet-only exposure" rail, but only for machine-to-machine links. The web UI is never on the LAN.
11. **No Mac to test on.** Mac support is built and CI-tested, and stated as **unwalked**.
12. **Binaries ship unsigned for now.** Each card states the one-time "Run anyway"/"Open" step.
    Machines with Smart App Control on are stated "cannot". Signing stays a seam in CI.
13. **Tailscale OAuth credential allowed now.** Login links ship first; the credential follows.
    - It is stored like provider keys are today: write-only, never in her context or logs, excluded from backups.
    - Proposal A (secrets at rest) is widened later to cover core.
14. **A Windows hub requires WSL for now.** `install.ps1` says so. Windows nodes and clients are unaffected.
15. **Order.** Roadmap item 0 (the core suite wedge) first, then this lane (S40–S49). That puts
    this lane ahead of S26 and doing-things; doing-things rebases onto the new novad later.

### Owner decisions (2026-09-21, for S41)

16. **The mini PC's old platform-line `nova` stack is deleted, containers and volumes.** `install.sh`
    refuses while it is there, names every container and volume it found, and only then offers a
    removal bounded to exactly what it named. Deletion is irreversible, so the offer states what it
    destroys and defaults to doing nothing.
17. **S41 ships the encrypted bundle of ARCS arc 8**, not the plain tar its own bullets below still
    describe: encrypted bundle, passphrase **resolver seam** (not the secrets store), the restore
    script inside every bundle, and coverage **derived from the compose file** that REFUSES on an
    unclassified volume. `BACKUP_EXCLUDE_DATA`, the hand-kept list, is not built. Arc 8 wins wherever
    it contradicts the S41 section; the reasoning is in `s41/rulings.md`.

### Measured facts (2026-09-18)

- **Hub: AZW MINI S.**
  - Hardware: N150 (4 cores, AVX2), 16 GB RAM, 351 GB free, Intel iGPU.
  - Software: Pop!_OS 24.04 (Debian/Ubuntu family), Docker 29.8, compose v5.5.1, host Tailscale.
  - Network: Wi-Fi 192.168.0.245/24.
  - Already runs minecraft containers.
  - A docker bridge already sits on **172.18.0.0/16**, the subnet v4 pins.
  - It can run the embedder, but not Nova's chat prompts.
- **Node: DELL-XPS-8950.**
  - Docker there is Docker Desktop; WSL runs systemd with mirrored networking.
  - S3 sleep is supported. The BE200 Wi-Fi is wake-armed (<dell-wifi-mac>, 192.168.0.140).
  - The Ethernet is unplugged, and ProtonVPN is up.
  - novad runs inside WSL (it will be retired for a Windows-native agent).
- **Repo, at HEAD 0531b496:**
  - registry has 39 tools; the eval corpus has 23 cases at `suite_version` 13;
  - next free migrations are core 035 and gateway 009;
  - novad is Linux-only (`Statfs`, `/proc`, `notify-send`, XDG, platform hard-coded to "linux");
  - the path check is POSIX-only (`tools/devices.py:108-116`);
  - the repo is public.
- **External facts, checked 2026-09-18:**
  - PWAs install on Chrome/Edge without a service worker.
  - Tailscale cannot carry WoL, so a helper on the LAN must send the packet.
  - Tailscale auth keys last 1–90 days; one-off keys revoke after use; tagged devices get no identity header.
  - Ollama `/api/ps` `size_vram` is vendor-neutral. Ollama on Windows is a per-user install with no admin.
  - Docker Desktop on macOS has **no GPU**, so Mac models must run in native Ollama (Metal).
  - CUDA can vanish after resume.
  - GitHub runners exist for macos-15, macos-15-intel, windows-2025, windows-11-arm and ubuntu-24.04-arm.

## Architecture

```
 phones / PCs (PWA) ─https─▶ HUB (always on; Linux | macOS | Windows+WSL)
                             compose: web·core·gateway·memory·postgres·searxng
                                      ollama "hub" (bundled; embedder + small models)
                                      tailscale sidecar (serve 443 + outbound proxy)
                             host novad (transport host): wake relay, native models (e.g. Mac Metal)
                                   │ gateway ─(tailnet | headscale | lan)─▶ NODE novad (any OS)
                                   │                                       models role: pinned-TLS + bearer
                                   │                                       proxy ▶ native/container Ollama
                                   └ magic packet via any agent on node's LAN   hold · facts · hands
```

## Key decisions

| # | Decision |
|---|---|
| D1 | **The one agent is `novad`.** Pure Go with `CGO_ENABLED=0`, built for 6 targets with per-OS build tags. On Windows it is **always the native build**. It reaches WSL through `wsl.exe` and `\\wsl.localhost`; running the agent inside WSL is refused with "cannot". |
| D2 | **A role is availability, never permission.** The agent reports raw facts. Core alone derives each role, with its reason (`device_facts.py`). The owner's switch is `engines.serving`. No `capabilities` column is added (`test_no_approvals.py:289`). |
| D3 | **How the agent runs:** Linux as a systemd user unit plus linger; macOS as one LaunchAgent; Windows through an HKCU `Run` key → `novad supervise`. `supervise` owns restart and the `.prev` revert, and becomes S31's revert mechanism. System-service modes are a seam. |
| D4 | **Hold is in-process and driven by a lease** (`X-Nova-Hold-S`, 60–1800 s, plus in-flight). Windows uses `PowerSetRequest`, falling back to `SetThreadExecutionState`. macOS uses `caffeinate -i -s -w`. Linux takes a logind Inhibit over D-Bus. After a network wake it also holds for `min(120 s, wake_max_wait_s)`. |
| D5 | **Transport seam:** `host \| system \| tailnet \| headscale \| lan`. A transport locates; it never establishes identity. Identity is the ed25519 device key, the pinned core key, the bearer and the pinned TLS certificate. |
| D6 | **How agents reach the hub.** `host` is loopback. `tailnet`/`system` use the existing `https://<hub>.ts.net`, with nginx exempting enroll and `/api/v1/agent/*` from the gate. `headscale`/`lan` go through a new pinned-TLS `edge` container. |
| D7 | **Models listener.** The agent's own self-signed TLS on every transport, pinned at link time, with a bearer stored on the agent as sha256. An explicit mux holds the Ollama allowlist. The `/api/pull` body is validated (the CVE-2024-37032 class). The mux cannot reach `caps.Dispatch`. |
| D8 | **`hub` is always the bundled container** and remains the embedder. A native Ollama on the hub machine is a **separate engine named after that machine**. |
| D9 | **Gateway dial per `engines.transport`.** `internal` → `OLLAMA_URL`. `host` → `host.docker.internal` (via `extra_hosts` on Linux). `tailnet`/`headscale` → the sidecar's CONNECT proxy on an internal network. `lan` → direct. |
| D10 | **Compute identity, defined before any row exists.** Grammar: `gpu:<cuda\|rocm\|metal\|vulkan>:<key>` or `cpu:<slug>\|<n>c\|<GiB>g`. `size_vram` rules decide the stamp; an ambiguous case is **omitted, never guessed**. `runtime` (container, native, wsl) is recorded separately. Speed is keyed by (model, `served_on`, `runtime`) and fit by (compute, model). |
| D11 | **Signed envelopes:** `models.link/unlink`, `net.join/leave`, `net.wake`, `agent.configure` (two-phase, rolls back unless verified over the new path), and `facts.refresh`. |
| D12 | **Revoke order:** engine delete → `models.unlink` → `net.leave` → device revoke → `auth_error{revoked}`, after which the agent wipes its state. The tailnet node is deleted through the API when a credential exists; otherwise the admin step is stated. |
| D13 | **Downloads.** A one-shot `agent-dist` builder (pinned golang digest, reproducible) fills `v4_agent_dist`. Core serves a core-signed manifest. For tags, CI publishes GitHub Release assets, which a card lists only when their hash matches. Every card command **verifies the sha256 before running**. |
| D14 | **Tailscale join.** *Reach-first*: the machine enrolls, then `net.join`; the AuthURL appears as a `card{join_link}`. *Join-first*: a minted tagged key joins with no click; without a credential, the hub's join window relays the link into her card, or it prints in the terminal with a QR code, stated. |
| D15 | **Credential:** an OAuth client with `auth_keys` (plus `devices:core` optionally), stored in core `network_credentials`. Minted keys are single-use, preauthorized, `tag:nova-agent`, 1 day. They are deleted at burn and the deletion read back. A key goes in through an env var, never argv or a unit file. `tskey-*` in the owner's input is redacted. |
| D16 | **Key expiry.** Check `tailnet_key_expiring` fires 14 days ahead. `wake.plan` gives cause `key_expired`. |
| D17 | **Hub overlay state** is the file `/run/nova-status/tailscale.json`, written only by `start.sh`. The tailnet origin is **derived** from it; no table stores it. |
| D18 | **Headscale** is a hub compose service. Core mints preauth keys (no login links). Its thin clients are browser-only and not installable, stated. |
| D19 | **LAN relaxation, exact.** Only the `edge` on one private address (DHCP reservation stated), agent models listeners on RFC 1918/ULA addresses, and the join window while a code is live. The web UI is **never** on the LAN, pinned by `exposure_test.sh`/`edge_test.sh`. mDNS is a seam. |
| D20 | **Hub OS support:** Linux (walked), macOS (CI), Windows+WSL (walked). Windows without WSL gets a stated "cannot" plus `wsl --install`. |
| D21 | **Kept from the first design:** `providers`+`engines`, the `hub` rename, the derived **wait rule** (only a role's own chain or a chat `requested` link may wake a machine, so beats never do), the typed **409 `engine_asleep`** before any byte, `X-Nova-Skip-Engines`, connect failures never walled, per-engine caches with failures cached, `engine_models`, handover, core `wake_attempts` (rate limit, no-wait rule, one budget per turn, late watcher, `ready_cpu`), the code card never entering her context, and verified backup/restore/move. |

## Support matrix (W = walked on our hardware; C = built + CI, **unwalked**; M = walked if P0 passes; S = seam)

| | Linux | macOS | Windows native | Windows+WSL |
|---|---|---|---|---|
| Hub stack + install + backup/restore | W | C | S (needs WSL) | W |
| Agent hands / facts | W | C | W | through the Windows agent |
| Agent models | W (N150 CPU) | C (Metal, macOS 14+) | W (native / Docker Desktop, P0-4) | M (P0-21) |
| Agent hold | M (P0-9) | C | M (P0-5) | Windows |
| Agent relay (net.wake) | W | C (Local Network Privacy) | W (P0-13) | Windows |
| Transport tailnet / headscale / lan | W / W / W | C / C / C | W / M / W | Windows |
| Thin client PWA | tailnet W; headscale/LAN: browser only, stated | | | |

The walk status lives in `deploy/platform-walks.json`, pinned by a test. `machine_add_code` and
`machine_status` read it, so she says "not walked on a Mac yet" instead of implying it works.

## Order

**Item 0** (fix the core suite wedge) → **P0** (each measurement runs just before the slice it
gates) → S40 → S41 → S42a → S42b → S43a → S43b → S44 → S45 (the move) → S46 (wake) → S47
(thin clients; may land any time after S43a) → S48 (Headscale) → S49 (LAN).

- **Every slice** ships the backend and **her registered tool**, with guards, an eval case and a
  surface. It is deployed, walked in chat in her words, and its trace read by turn id. The web
  is checked at 393px, and a close-out plus carries are written.
- **Numbering:** these are S40–S49. doing-things claims S29–S37 and S38+.
- **Migrations:** core 035–038, gateway 009–010. Collisions with doing-things (core 035, the
  `Dispatch` table, the auth-frame `build`, registry/suite pins) are settled by the rule
  "whichever lands second renumbers and re-bumps once".

### Item 0: the core suite wedge (before S40)

The full core suite wedges at about 12% (`ROADMAP.md:41-57`), so no slice can show a full green.

1. Diagnose it with systematic-debugging.
2. Fix the cause.
3. Prove the full core suite green twice.
4. Record the finding in the ROADMAP.

## Phase 0: measurements

These are a spike: throwaway probes in the scratchpad, never product code. Results and the branch
each one selects go in `docs/plans/rebuild/hub-p0-measurements.md`.

- The senders and loggers run on the **mini PC**, because this session runs on the Dell and freezes when it sleeps.
- Jeremy's part: letting the Dell sleep, reading the BIOS "Wake on LAN/WLAN" and "Deep Sleep" settings, and approving tailnet joins.

| ID | Measure (machine) | Branch it selects | Gates |
|---|---|---|---|
| P0-1 | WoWLAN from S3: 3 send variants; 5 min ×5, 90 min ×3, overnight ×2; lastwake and event logs (Dell ← mini PC) | W1 → build S46. W2 → S46 with stated landing rates. W3 → S46 parked for this machine; owner question. | S46 |
| P0-2 | Does probing the tsnet node's IP wake it? | Sets `PROBE_WAKES_NODE` | S46 |
| P0-3 | Packet → `/agent/v1/ready` → first token, ×5 | Default `wake_max_wait_s` = ceil(1.5·p90), clamped 30–600 | S46 |
| P0-4 | CUDA after resume ×5: Docker Desktop vs native Windows Ollama | The Dell's runtime; both fail → owner question | S44/S45 |
| P0-5 | A Go probe started from the Run key: `PowerSetRequest` vs `SetThreadExecutionState` after an unattended wake; which power reads need elevation | The hold mechanism, or "hold impossible" stated; `unreadable[]` | S44 |
| P0-6 | Docker Desktop / Ollama tray: reboot with no sign-in, resume, clock skew | Stated prerequisite; owner question only if it matters | S44 |
| P0-7 | tsnet in a Run-key process with ProtonVPN on and off, next to host Tailscale: direct or DERP, p50/p99 through the sidecar proxy, SSE intact, tok/s, failure mode while asleep, firewall prompt (Dell and mini PC) | Sets `ENGINE_REACH_S`; coexistence fails → `system` seam; no path → owner question | S43a |
| P0-8 | Embedder latency and cosine parity on the N150 | Re-derive the budgets or re-embed | S45 |
| P0-9 | logind Inhibit `sleep` vs `idle` from a linger unit; does COSMIC auto-suspend honour it; capacity and subnets (mini PC) | Else a one-line polkit rule the owner runs | S44 |
| P0-10/11 | Longest silence in a pull; gaps between rounds and turns | Pull timeout; default `hold_s` | S44 |
| P0-13 | Broadcast egress interface on Windows with Wi-Fi, vEthernet, ProtonVPN and Tailscale up (tcpdump on the mini PC) | Subnet-directed only, or relay "cannot" | S46 |
| P0-15/18 | container → `host.docker.internal` → a Windows loopback listener; Linux bridge gateway with ufw | Bind choice, or the stated ufw rule | S44 |
| P0-16/17 | Readable Ollama `inference compute` lines per runtime; the Windows vs container nvidia UUID | Stamp source; whether fit carries over | S44/S45 |
| P0-20 | An unsigned exe via `curl.exe`: SmartScreen, Smart App Control, Defender, Run-key console flash | Card wording; SAC on → stated "cannot" | S42b |
| P0-21 | Ollama inside WSL reached from Windows at 127.0.0.1 | The WSL-Ollama path, or "cannot" | S44 |
| T9 | OAuth: `tagOwners` prerequisite, key → Running, minimum expiry, device approval (owner's tailnet) | Else login links only | S43b |
| T12/13, T3/T4 | Headscale control URL on tsnet (including Windows syspolicy); LAN reachability, Wi-Fi client isolation, firewall rule | Branch per case | S48/S49 |

## Slices

### S40: engines and measurement identity (Dell hub; builtin engine only)

**Status: SHIPPED and walked 2026-09-19.** Close-out in [`slice-40-engines.md`](slice-40-engines.md); carries in [`slice-40-carries.md`](slice-40-carries.md). Core 035 and gateway 009 are used.

**Gateway migration `009_engines`:**
- delete the `ollama` walls; rename the builtin `ollama` → `hub` and rewrite the `routes.chain` links;
- new tables `engines` (lifecycle, serving, hold_s, cached tags and facts, with dated-pair CHECKs) and `engine_models`;
- `probes` gains `provider/compute/runtime/path`; `usage_events` gains `served_on`;
- providers CHECKs.

**Core migration `035_hub_engine`:** `chat.model` / `chat.vision_model` `ollama:X` → `hub:X`.

**Gateway files:**
- new `app/engines.py` (rows, observe, TTL caches that also cache failures, `client()`), `app/engines_api.py`, and `app/compute_id.py` (the D10 grammar, with golden vectors in `docs/contracts/compute_id_vectors.json`);
- generalise every site that assumes one builtin: `routing.py:277-389`, `catalog.py:89,171,339-577`, `admin.py:141-227,389-396,659-681,1141`, `providers.py:82-92,222-237`, `backends.py`;
- `data_plane.py` stamps `X-Nova-Served-On`/`-Runtime`;
- delete `/admin/vram`;
- `devices_vram._QUERY` adds `uuid,name`.

**Core files:**
- new `app/machines.py` (a `PLANT` ContextVar: `GatewayPlant`, and `FixturePlant` over `eval_*` names) and `machines_api.py`;
- generalise `LOCAL_PROVIDER` (`models_catalog.py:34`, `tools/models.py:43,446`, `checks/stack.py:49`, `vision.py:113`);
- `inference_health`, `checks/inference.py` and `resources_api.py` read `/admin/engines`;
- `model_speed._RATES_SQL` is keyed by (model, `served_on`, `runtime`);
- `chat._gateway_round` stores `served_on`.

**Tools** (39 → 41):
- `machine_status`: reads_only, AUTO_RUN; facts `{machine, answering, checked_now, at}`;
- `machine_configure(serving)`: reads its values back.

**Guards:** model-ref prefix generalised (`guards.py:125,133,1862`); narration kind `configured_machine`; two capability phrases.

**Evals** (suite 14, corpus 25): `checks-where-models-run-before-saying`, `switches-serving-off-when-told`.

**Web:** `MachinesSection.tsx` first on the Models tab; about 20 fixtures `ollama:` → `hub:`.

**Walk:**
1. The setting reads back `hub:qwen3.8:27b`.
2. "Where do your models run?" → she calls `machine_status`.
3. The probe row reads `gpu:cuda:<uuid>`, `runtime=container`.
4. "Stop running chat models here" → the route frame names the link that answered.

### S40b: honest claims about machines, models and memory (unplanned; the S40 walk found it)

**Status: SHIPPED and walked 2026-09-19.** Plan and close-out in
[`slice-40b-honest-machine-claims.md`](slice-40b-honest-machine-claims.md); the design authority
is [`s40b/design-verdict.md`](s40b/design-verdict.md); carries in
[`slice-40b-carries.md`](slice-40b-carries.md). No migrations.

The S40 walk ended with three false sentences in her replies and no guard firing on any of them:
she replayed an earlier machine reading as current (timestamp included) without calling
`machine_status`, named a model as current that did not serve the turn, and called memory
unreachable in a turn whose recall had answered.

- `state_claim_check` gains **machine subjects**, derived per turn from that turn's spans, armed
  on chat and eval turns only. Its evidence is a read of that machine this turn or a served round
  on it.
- New `served_claim_check` and `memory_claim_check`, both APPEND.
- `stack_claim` stops correcting honest negations; `live_facts` keeps each auto-run's facts; the
  prompt line about "the model answering" is made true instead of guessed.
- **History stamps** mark scheduled and beat rows, and rows that read live facts, as records of
  their moment — so an old reading is not handed back to her as current.
- Eval predicates stop counting unasked backend spans as her calls; corpus v15 adds
  `does-not-replay-a-machine-reading-as-current`.

This is the guard half of what S44 needs: S44 adds a machine that can be **asleep**, and the same
subjects then carry the 409 as evidence.

### S41: portable hub + verified backup/restore drill (operator tooling)

> **Reconcile with `ARCS.md` arc 8 before building (added 2026-09-18, after the
> product map landed in PR #66).** Arc 8 lists these as *already decided* by the
> owner (v3 #31/#32). S41 is built to them, not to the plain-tar sketch below:
> - a **complete, encrypted** bundle, with the passphrase behind a **resolver
>   seam** ("eventually it'll get it from a secrets manager");
> - the standalone restore script travels **inside every bundle**;
> - coverage is **derived from the compose file**: an unclassified volume
>   **refuses** rather than silently skipping (this replaces the hand-kept
>   `BACKUP_EXCLUDE_DATA` list);
> - a **weekly restore drill** (her capability, on the S9 scheduler; S41 builds the verb, the schedule may follow).
>
> Because the bundle is encrypted, **secrets travel in it**. That reverses D15's
> "`network_credentials` excluded from backups", which existed only because a
> plaintext archive would leak it. Arc 8's closing note, "secrets and backups
> are the same slice in practice", means S41 and Proposal A (secrets at rest)
> should be planned together.

**`deploy/backup.sh` + `install.sh`, bash-3.2 portable:**
- **`backup`:**
  - stop the writers and verify they stopped;
  - record per-table counts and md5;
  - `pg_dump -Fc` inside the postgres container;
  - self-test restore into `nova_verify_*`;
  - tar the volumes with sha256 listings;
  - write the MANIFEST;
  - apply a data-driven `BACKUP_EXCLUDE_DATA` list.
- **`restore`:**
  - `decide_subnet` first; this fixes the 172.18 collision (`${NOVA_SUBNET}`, `NOVA_SUBNET_GATEWAY`);
  - verify the hashes;
  - refuse a non-empty target or an older `pg_restore`;
  - restore with `--single-transaction`;
  - re-verify counts, md5s and the signing-key fingerprint.
- **Modes:** `--drill` restores into throwaway volumes; `--move` / `undo-move` write `MOVED_TO`, and the sidecar refuses to start while it is present.
- **novad `repoint`.**

**CI:** `install_test.sh` and `backup_test.sh` also run on macos-15.

**Walk:** back up on the Dell, then `restore --drill` on the mini PC. Counts, md5s and the key fingerprint must be equal.

### S42a: the agent on every OS (hands + facts)

**`apps/novad`:**
- new `internal/platform/*_{linux,darwin,windows}.go` plus `fake.go`;
- split `caps/system.go` (`:31-32`, `:79`, `:97`, `:54-71`) into per-OS files; apps per OS; `procattr` per OS;
- a dispatch table shared with doing-things S30;
- `internal/facts`, the auth-frame `facts`, and the `facts` frame;
- config via `os.UserConfigDir`, with a Windows DACL;
- enroll sends `runtime.GOOS`;
- `client.go`: reset the backoff, add a ping and a resume detector, treat `revoked` as fatal and wipe;
- a WSL guard.

**CI:** `rebuild-ci.yml` becomes a matrix:
- vet on 3 OSes;
- 6 targets built twice, with the sha256s compared;
- native `go test` on the arm, macOS ×2 and Windows ×2 runners.

**Core:**
- migration `036_agent_facts`: platform CHECK, `devices.facts`/`facts_at`, a `machine_uid` index;
- new `device_facts.py`: roles with reasons, plus a `duplicate_agent` check;
- a platform-aware `_check_fs_path` (Windows paths via `ntpath`, including `\\wsl.localhost`);
- `machine_status` grouped by machine.

**Eval** (suite 15): `points-wsl-at-the-windows-agent`.

**Walk (Windows-native agent on the Dell):**
1. List the Windows Desktop.
2. Open Notepad.
3. A toast notification.
4. `wsl.exe … uname -a`.
5. Retire the WSL novad, leaving one agent for `dell`.

**Unwalked:** macOS, arm64.

### S42b: install, service, downloads, the code card

- **Agent:** `internal/service` (systemd user unit plus linger, plist, Run key); verbs `install` (idempotent upgrade), `uninstall`, `supervise`.
- **Deploy:**
  - an `agent-dist` builder and the `v4_agent_dist` volume;
  - nginx gate carve-outs, pinned in `gate_test.sh`;
  - `install.sh` installs the hub-host agent (transport `host`);
  - `install.ps1` stub: a Windows hub without WSL is told "cannot" plus `wsl --install`.
- **Core:**
  - new `agent_dist.py` (signed manifest; public paths, rate-limited);
  - `machines.add_code` builds a per-OS card (POSIX `sh`, and PowerShell 5.1), each verifying the sha256 before running;
  - `deploy/platform-walks.json` plus its test.
- **Tool** (→ 42): `machine_add_code(name?, for_os?)`. The code reaches only the card, never her context.
- **Guards:** `credential_claim` at both guard sites; the `_SETUP_MACHINE` offer class.
- **Eval** (suite 16): `adds-a-mac-through-the-card`. She must say it has not been walked.
- **Walk:**
  1. "Set up your agent on my mini PC" → the Linux tab → the hash verifies → the unit and linger are installed.
  2. The Dell gets the PowerShell card with no admin; the Run key survives a sign-out.
  3. "Add my MacBook" → she says it has not been walked.

### S43a: Tailscale by login link

- **Deploy:**
  - `start.sh` waits on NeedsLogin instead of dying;
  - a status-file loop (D17);
  - the `tailnet_egress` internal network with `TS_OUTBOUND_HTTP_PROXY_LISTEN`, and the gateway gets `NOVA_TAILNET_PROXY`;
  - an optional authkey in `decide_tailnet`;
  - `exposure_test.sh`.
- **Agent:** `internal/transport/{host,system,tailnet}.go` (tsnet); `net.join`/`net.leave`; the two-phase `agent.configure`.
- **Core:**
  - migration `037_network`: `pairing_codes.transport/ts_key_id/ts_key_deleted_at`, `devices.last_transport`, `network_credentials`;
  - new `network.py` (derived origins);
  - the `tailnet_key_expiring` check.
- **Tool** (→ 43): `machine_join(machine, transport)`. It returns the state immediately; completion is seen through frames and `machine_status`.
- **Guards:**
  - `credential_claim` also covers `tskey-*` and login URLs, and `tskey-*` is redacted from input;
  - `state_claim` gains the words `joined`/`on the tailnet`;
  - narration kind `joined_machine`;
  - the `_JOIN_TAILNET` offer class.
- **Evals** (suite 17): `joins-a-paired-machine-to-the-tailnet`, `says-login-is-pending-not-joined`.
- **Walk:**
  1. "Put the Dell's agent on your tailnet" → a link card appears → approve it → she reports tsnet, direct or DERP, with ProtonVPN on and off.
  2. The same for the mini PC.
  3. The hub itself joins through a link from an isolated project.

### S43b: the credential, join-first, the release channel, revoke

- **Settings → Network (`NetworkSection.tsx`):**
  - a write-only credential form, verified by an OAuth token plus a key list;
  - a `tagOwners` snippet.
- **`tailscale_api.py`** behind a `control_plane` interface: minting in `add_code`, and a key janitor that deletes and reads back.
- **Join-first:**
  - a foreground join in `novad install`;
  - the hub agent's join window, open only while a code is live;
  - the `join_pending` frame.
- **Release channel:** a CI release job with `SHA256SUMS`.
- **Revoke** in the D12 order.
- **Backups** exclude `network_credentials`; the `network_credential_missing` check asks for it again after a restore.
- **Eval** (suite 18): `keeps-the-tailnet-key-off-the-page`.
- **Walk:**
  1. With the OAuth client: a tagged join with no click.
  2. Without it: the join window relays the link into her card.
  3. An unused key is deleted, confirmed by read-back.
  4. Revoke removes the tailnet node.

### S44: the models role; engines over agents

- **Agent:**
  - `internal/models`: proxy, lease, `/agent/v1/{live,facts,ready}`, allowlist, pull-body validation;
  - `internal/pin`, `internal/compute`;
  - `internal/hold/{linux,darwin,windows}`;
  - runtime detection;
  - `models.link`/`unlink`.
- **Gateway:**
  - migration `010_engine_agents`: `machine_id`, `transport`, `tls_cert_pem`, `tls_spki_sha256`, `runtime`, with CHECKs;
  - `engines.client` gets an SSL context pinned via `cadata` (`adapters/base.py:127`);
  - routing adds the wait rule, the 409, a pre-serve `/ready` and the lease;
  - `admin.pull` works per engine and uses the node's free disk;
  - `accel` feeds fit and suggest.
- **Core:**
  - `machines.link_models` (signed → gateway create → read-back → compensating unlink);
  - `machine_configure(runs_models, lifecycle, hold_s)`;
  - `stack.chat_model` returns `NotDue` for a sleeping node (no 3 am urgent push);
  - `checks/machines.py`.
- **Guards:**
  - `state_claim` gains machine subjects, with evidence only from a checked-now fact or the 409;
  - the `stack_claim` carve-out (`guards.py:4705`);
  - `where_served_claim`.
- **Tests:**
  - a real TLS socket: a wrong key gets zero accepts;
  - the mux is isolated from `Dispatch`;
  - a node transport that raises if touched during catalogue, explain or suggest.
- **Eval** (suite 19): `enables-models-on-a-machine`, where the plant intercepts `devices_ws.hub.command`.
- **Walk:**
  1. The mini PC as a CPU node over the tailnet: `mini:qwen3:0.6b` serves, the span shows `served_on`, and the hold is visible.
  2. The Dell's native or Docker Desktop Ollama through its Windows agent: `served_on=gpu:cuda:<uuid>`, and `powercfg /requests` shows Nova's hold.
  3. Revoke `mini`: the bearer is refused.
- **Unwalked:** Metal, AMD, Intel.

### S45: the move and handover

**Runbook.** Every step is verified by what it prints:
1. Same commit on both machines.
2. A drill restore on the mini PC.
3. The Dell agent is already on the tailnet.
4. `backup --move` on the Dell.
5. `scp` over the tailnet, with sha256 on both ends.
6. `restore` on the mini PC.
7. `NOVA_TAILNET=1 ./install`. All services healthy, and the embedder returns 768 dimensions.
8. The phone PWA is still signed in, with its threads.
9. The Dell's Ollama runs in the runtime P0-4 chose.
10. Install the hub-host agent on the mini PC.
11. Handover in chat.
12. A 7-day soak.

Rollback: `undo-move`, then bring the Dell stack back up.

**Tool** (→ 44): `machine_handover(from, to)` rewrites the chains and `chat.model`, reads them back, and states which models are not installed on the target.

**Eval** (suite 20): `moves-local-models-when-asked`.

**Walk:**
1. `served_by=dell:qwen3.8:27b`.
2. Fit for `dell:` reads the S40 probes only if P0-17 passes.
3. With the Dell asleep, a beat is not woken, and recall still runs.

### S46: wake

**Core migration `038_wake`:**
- `machine_overrides(device_id, mac_override[1..4], relay_override)`;
- `wake_attempts`, with outcomes `ready|ready_cpu|late|no_answer|not_asleep|not_waited|stopped|interrupted`. A row is written only after the relay's signed "sent".

**Agent:** `net.wake {macs[], subnet, unicast_ip?, port}` from any OS. It reports *sent*, never *woke*.

**Relay** = any connected agent in the node's subnet, verified by gateway MAC.

**Core `wake.py`:**
- single-flight per engine;
- a rate limit counted from `settled_at`;
- a no-wait rule after 3 straight `no_answer`s;
- one budget per turn, with stop checked on every 2 s poll;
- `/ready`, then `/load`, then check `size_vram`;
- a late watcher.

**Turn flow:** `chat._gateway_round` 409 → `through_sleep` → a new `llm_call` span. `wake` SSE frames go to the pending bubble. Past the deadline, `X-Nova-Skip-Engines` sends the chain on with the reason stated.

**Wake checklist**, from facts, per OS:
- Windows: WoMP, hibernate-after, Fast Startup;
- macOS: "Wake for network access";
- Linux: `ethtool wol g`, NetworkManager wake-on-lan;
- BIOS/firmware steps she states but cannot do herself.

**Checks** (non-urgent): `wake_failed`, `hold_failed`, `wake_relay_missing`, `key_expired`.

**Tool** (→ 45): `machine_wake`. The result states the MACs, relay, seconds until answering, load time, VRAM fraction and the hold, or "N of the last M landed".

**Guards:** narration kind `_WOKE_MACHINE`, backed only by a wake span with outcome ready; the `_WAKE_MACHINE` offer class.

**Evals** (suite 21; the fixture plant sends no real packets):
- `checks-the-machine-before-saying-it-is-asleep`
- `wakes-the-machine-when-asked`
- `says-so-when-a-wake-does-not-land`
- `says-the-key-expired-not-asleep`

**Walk (on the P0-1 branch):**
1. Pair and derive the relay: she states the MACs and the relay, "not verified yet".
2. "Wake it" → progress lines, then the measured seconds.
3. With chat on `dell:`, "hi" shows the wake progress, then the answer; read the wake span and the attempt row.
4. With the ceiling at 30 s and WoMP off → link 2 answers with the reason stated.
5. A 3-minute answer after an unattended wake completes.
6. Overnight: no urgent push.

### S47: thin clients

- Tool `nova_address` (reads_only, AUTO_RUN; → 46).
- `OpenElsewhere.tsx` per access mode:
  - a QR code of the **derived** origin, never loopback;
  - per-platform install steps;
  - a Tailscale-invite step for household members;
  - `trusted_https` stated.
- Guard `address_claim`.
- Eval (suite 22): `gives-a-real-address-never-the-lan-app`.
- **Walk:** "How do I put you on my tablet?" → a phone scans the QR code and installs the PWA.

### S48: Headscale

- A pinned `headscale` compose service and `decide_headscale`.
- The sidecar logs in with `--login-server`.
- The `control_plane` headscale implementation (preauth keys).
- The `edge` door for agents.
- The `hub.moving` envelope.
- Eval (suite 23).
- **Walk** (an isolated project on the mini PC): the Dell agent joins and a turn is served over Headscale; a phone is browser-only, and she states it.

### S49: plain LAN

- The `edge` service plus `edge_test.sh`; `decide_lan` (DHCP reservation); `edge_guard`.
- The agent's `lan` transport.
- A one-time elevated Windows firewall rule from `novad install --lan`.
- Core updates `base_url` from facts.
- Eval (suite 24).
- **Walk:**
  1. The door on 192.168.0.245.
  2. The Dell serves over the LAN.
  3. From the phone: the UI returns 404, `:3000` is refused, and an unauthenticated `:11435` is refused.
  4. A changed DHCP lease is followed.

### Seams (not scheduled)

- A Windows hub without WSL.
- System-service modes (LaunchDaemon, Windows Service, Linux system unit).
- mDNS.
- ACL writes (a2).
- Code signing and notarization.
- An own-domain HTTPS mode so phones can install from the LAN.
- Nova running installs herself (after doing-things S30's detached jobs).
- S31 self-update for six targets.

## Pinned suites that move (deliberately, with the reason written)

- `test_tools_registry.py:115,501,550`: 39 → 46 across the slices.
- `test_live_facts` and `test_capability_guard` MUST_FIRE.
- `test_eval_corpus.py:376-377,382,423`: suite_version 13 → 24, corpus 23 → 39.
- `test_settings` KNOWN_KEYS: +`machines.wake_max_wait_s`.
- `test_checks`: fixture key becomes `hub`; the urgent set is **unchanged**.
- Gateway: `test_catalog`, `test_routing`, `test_providers`, plus the tests for the deleted `/admin/vram`.
- `tabs.test.tsx:47`.
- `install_test.sh`, `start_test.sh`, `gate_test.sh`.
- `test_no_approvals` stays **unchanged and green**. Every refusal says "cannot".

## Verification (each slice)

1. Suites green by hand:
   - core in full (after item 0), gateway, memory;
   - web via `npm test` plus tsc;
   - novad with `go test -race` on every runner;
   - the shell tests.
2. Deploy to the real stack, building images from the commit (`git archive HEAD:<dir> | docker build`).
3. Walk the DoD in chat in her words, and read `turn_spans` **by turn id**: `served_by`, `served_on`, `runtime`, wake, join and guard spans.
4. Check the web at 393px.
5. Update `platform-walks.json`, then the slice close-out and carries, the ROADMAP index and order of work, and `deploy/README.md` (Backups, Moving Nova, Machines, Networking, the rails).

## Execution notes

- **First act after approval: preserve the designs.** Copy the reports, both design rounds and
  all critiques from the session scratchpad (`reports/`, `design/`, `xplat/`) into
  `docs/plans/rebuild/hub/`, and write `docs/plans/rebuild/hub-topology.md` as the index. The
  scratchpad does not survive sessions.
- Then item 0, then P0 and the slices in order, on branches `slice/sNN`. Use the SDD/epic loop,
  with an adversarial review per slice.
- **Only Jeremy can do these:**
  - BIOS reads;
  - letting the Dell sleep;
  - approving tailnet joins, or providing the OAuth client;
  - running a card's command on a new machine;
  - the phone installs.

## Owner questions left (asked only if a measurement triggers them)

1. P0-1 is W2 or W3: a stated fallback while the Dell sleeps, keep it awake, or change its timers?
2. P0-6 shows sign-in is required after a reboot: accept that, or turn on automatic sign-in?
3. P0-7 finds no path with ProtonVPN up: split-tunnel Tailscale, or use the `system` seam?
4. P0-9 shows the logind idle inhibitor does not hold: run a one-line polkit rule once?
