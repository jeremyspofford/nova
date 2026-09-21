# Hub lane, Phase 0 measurements

Each measurement runs just before the slice it gates
([`hub-topology.md`](hub-topology.md), "Phase 0"). Probes are throwaway (the
session scratchpad), never product code. Every row states what was measured,
on which machine, and which design branch it selects. GPU UUIDs and MACs are
redacted: the repo is public.

## Measured 2026-09-18

### P0-16: can Ollama's `inference compute` line identify the card? (Dell, Docker Desktop container)

**Measured.** `docker logs nova-ollama-1` carries one line per start:

```
msg="inference compute" id=0 library=CUDA compute=8.6 name=CUDA0
description="NVIDIA GeForce RTX 3090" libdirs=ollama,cuda_v13 driver=13.3
pci_id=0000:01:00.0 type=discrete total="24.0 GiB" available="22.8 GiB"
```

- It gives the **library, bus id and total memory, but no UUID**.
- **Branch.** For the bundled engine, the UUID for `gpu:cuda:<uuid>` comes from `nvidia-smi` in the gateway container, as S40 does. For agent engines (S44), the line settles the library and `nvidia-smi` supplies the key. When neither is readable, the stamp is omitted.
- The line re-appeared at about 11:25 UTC on each of 09-16, 09-17 and 09-18, i.e. once per start. Not investigated.

### P0-17: is the GPU UUID the same from every vantage point? (Dell)

**Measured.** `nvidia-smi` UUIDs were compared from three vantage points: Windows (`nvidia-smi.exe`), the Ollama container, and the gateway container. They are **identical**.

**Branch.** Probes stamped `gpu:cuda:<uuid>` under S40 on the Dell's bundled engine carry over to the `dell:` engine after the move (S45 walk step 2). Fit keeps its history.

### P0-18: can a Windows-native process reach Docker Desktop's `127.0.0.1:11434`? (Dell)

**Measured while awake.** `curl.exe http://127.0.0.1:11434/api/version` returned `{"version":"0.33.1"}`.

**Branch.** The Windows-native agent's models role can front Docker Desktop's Ollama over loopback. **Still to measure:** the same after an S3 resume (P0-4/P0-6).

### P0-11: gaps between LLM rounds and between chat turns (Dell, live `turn_spans`, last 30 days, read-only SQL)

| Gap | n | p50 | p95 / p75 | max / p90 |
|---|---|---|---|---|
| Between `llm_call` rounds within a turn | 1,128 | 0.0 s | p95 2.0 s | max 1,412.8 s (a long tool run) |
| Between consecutive chat turns | 219 | 184 s | p75 1,878 s | p90 15,768 s |

- Of the gaps between chat turns, 65% are ≤ 600 s and 75% are ≤ 1,800 s.
- **Branch.** The default `hold_s = 600` stands. A lease renewed on every request covers the rounds within a turn. Holding for 10 minutes after the last use covers two thirds of follow-ups, and the Dell still sleeps through the long idle stretches (p90 is about 4.4 h).

### P0-9 (read-only part): the mini PC as a hub

| Fact | Value |
|---|---|
| Memory | 15.4 GiB total, **12.5 GiB available** with the minecraft containers running |
| `loginctl` Linger | **yes** (already enabled) |
| GNOME AC sleep (`sleep-inactive-ac-type`) | `nothing`; no COSMIC idle override present |
| Existing inhibitors | ModemManager, NetworkManager and UPower (sleep, delay) |
| Docker networks | `bridge` 172.17/16; `docker_default` **172.18/16**; `jobhunter_default` 172.19/16; `nova_nova-internal` 172.20/16; `project_nova-internal` 172.21/16 |
| Failed user units | `openclaw-gateway.service`, `xdg-desktop-portal-gtk.service` (unrelated to Nova) |

**Finding (RESOLVED 2026-09-21 — archived and removed on the owner's instruction; see `s41/map-minipc-measured.md`, "After the cleanup"):** the mini PC held a stopped Nova from the earlier platform line, **under the compose project name `nova`**:
- containers `nova-postgres-1`, `nova-orchestrator-1`, `nova-llm-gateway-1`, `nova-chat-api-1`, `nova-chat-bridge-1`, `nova-dashboard-1`, `nova-memory-service-1`, `nova-redis-1` and `nova-recovery-1`;
- volumes `nova_postgres-data` (67.66 MB) and `nova_redis-data` (37.06 kB).

v4's project is also `nova`. So `docker compose up` would adopt `nova-postgres-1` as its own `postgres` service container and recreate it, and it would report the rest as orphans. That is the same-project-name trap already hit on the Dell on 2026-09-07.

**Owner ruling 2026-09-21:** that stack is to be **deleted, containers and volumes**, by an installer that names what it found first (`hub-topology.md` decision 16, `s41/rulings.md`).

**Carried out the same day**, widened by the owner to "all old nova stacks, nova-ai-platform included": projects `nova`, `docker` and `project` were archived to `/home/jeremy/nova-old-stacks-archive` (21 MB, checksums verified by the operator) and then removed — 13 containers, 6 volumes, 3 networks, 7 images — with `minecraft` left running and `jobhunter` untouched. **172.18/16 is therefore free on that machine now**, and the only subnets left are 172.17 and 172.19.

### Correction, measured 2026-09-21: a `nova_` name does NOT mean the `nova` project

The line above previously listed `nova_pgdata` and `nova_redis_data` as that stack's volumes. **They are not.** Read back from `docker volume inspect`:

| Volume | `com.docker.compose.project` | Size |
|---|---|---|
| `nova_postgres-data` | **nova** | 67.66 MB |
| `nova_redis-data` | **nova** | 37.06 kB |
| `nova_pgdata` | **docker** | 75.77 MB |
| `nova_redis_data` | **docker** | 264 B |

Project `docker` is `/home/jeremy/repos/nova-ai-platform/infra/docker/docker-compose.yml`, and it also owns containers **named** `nova-redis` and `nova-postgres`. A deletion that selected by the name prefix `nova` — the obvious implementation — would destroy 75.8 MB belonging to a different project of his. **Selection must be by the `com.docker.compose.project` label, never by name.** `s41/map-minipc-measured.md` carries the full reading, and it is a pinned test in S41.

**And the old project's compose file is a directory.** `/home/jeremy/workspace/nova/docker-compose.yml` on the mini PC is a root-owned empty **directory** (the single-file bind-mount failure mode), so `docker compose -f … down -v` cannot remove that stack. Removal must be `docker rm` plus `docker volume rm`, selected by label. There is no v4 checkout on that machine and `/home/jeremy/workspace/nova` there is not a git repository.

### Host facts for S41's encrypted bundle (measured 2026-09-21)

bash **5.2.21**, OpenSSL **3.0.13**, GNU tar **1.35**, GNU coreutils **9.4** (`sha256sum`, `md5sum`), `shasum` 6.04, python3 **3.12.3**, gpg **2.4.4**, zstd **1.5.5**; **`age` is not installed**. Docker **29.8.0**, compose **v5.5.1**. Disk: 351 GB free of 460 GB.

Docker subnets in use on that host: **172.17, 172.18, 172.19, 172.20, 172.21** — all `linkdown` but allocated, so `decide_subnet` must land at 172.22/16 or beyond. Wi-Fi `wlo1`, 192.168.0.245/24, default via 192.168.0.1.

Other stacks on the machine that S41 must never touch: `minecraft` (**running**), `jobhunter`, `docker` (nova-ai-platform), `project`.

**Still to measure for P0-9:** whether logind's `Inhibit sleep` is refused and `idle` accepted from a linger unit, and whether COSMIC's auto-suspend honours it (before S44).

## Still to measure

| ID | Measurement | Gates | Needs |
|---|---|---|---|
| P0-1, P0-2, P0-3, P0-13 | Wi-Fi WoL from S3; whether probes wake the Dell; time to ready; broadcast egress | S46 | The Dell asleep (owner) |
| P0-4, P0-5, P0-6 | CUDA after resume; the hold from a Run-key process; Docker Desktop lifetime and clock | S44 | The Dell asleep and resumed (owner) |
| P0-7 | tsnet through ProtonVPN, next to host Tailscale | S43a | A Go probe plus a tailnet approval (owner) |
| P0-8 | The embedder on the N150 | S45 | A throwaway ollama on the mini PC |
| P0-9 (rest) | The logind inhibitor from a linger unit | S44 | A throwaway user unit on the mini PC |
| P0-10 | Longest silence during a pull | S44 | A large pull |
| P0-15 | Linux bridge gateway plus ufw | S44 | Mini PC |
| P0-20 | An unsigned exe through `curl.exe`: SmartScreen, Smart App Control | S42b | Dell |
| P0-21 | Ollama inside WSL reached from Windows | S44 | Dell |
| T9, T12, T13, T3, T4 | Tailscale OAuth; Headscale on tsnet; LAN reachability | S43b, S48, S49 | Owner's tailnet |
