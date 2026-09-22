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

**Measured 2026-09-21 (evening), below:** logind's `Inhibit sleep`/`block` IS refused from a linger unit and `idle`/`block` is accepted. The desktop's auto-suspend could not be exercised — no graphical session is logged in and nothing is configured to suspend on AC.

## Still to measure

(P0-8, the P0-9 linger half, P0-15 and the per-runtime P0-16/17 reading were
taken 2026-09-21 — see the section above.)

| ID | Measurement | Gates | Needs |
|---|---|---|---|
| P0-1, P0-2, P0-3, P0-13 | Wi-Fi WoL from S3; whether probes wake the Dell; time to ready; broadcast egress | S46 | The Dell asleep (owner) |
| P0-4, P0-5, P0-6 | CUDA after resume; the hold from a Run-key process; Docker Desktop lifetime and clock | S44 | The Dell asleep and resumed (owner) |
| P0-7 | tsnet through ProtonVPN, next to host Tailscale | S43a | A Go probe plus a tailnet approval (owner) |
| P0-9 (desktop half only) | Does the desktop's auto-suspend honour the idle inhibitor | S44 | An owner graphical login with `sleep-inactive-ac-type=suspend` — it sleeps the hub |
| P0-10 | Longest silence during a pull | S44 | A large pull — the 274 MB `nomic-embed-text` pull taken 09-21 was far too small, and `/api/pull` carries no timestamps |
| P0-20 | An unsigned exe through `curl.exe`: SmartScreen, Smart App Control | S42b | Dell |
| P0-21 | Ollama inside WSL reached from Windows | S44 | Dell |
| T9, T12, T13, T3, T4 | Tailscale OAuth; Headscale on tsnet; LAN reachability | S43b, S48, S49 | Owner's tailnet |

## Measured 2026-09-21 (evening): the mini PC as a hub

Taken against the mini PC's own **empty, disposable** v4 stack (installed the
same day, compose project `nova`, seven healthy containers, no tailnet
profile) and, for the comparisons, against the Dell's live stack read-only.
Probes are throwaway: `/tmp/p0-*.{sh,py}` on the mini PC and the session
scratchpad on the Dell. Nothing in either stack was stopped, restarted or
removed; after the run the mini PC had all seven containers healthy, no probe
listeners and no probe units.

**One state change was made, deliberately:** `nomic-embed-text` was pulled
into the mini PC's `v4_ollama` volume (`POST /api/pull`, 274 MB, 8.5 s
wall, digest `0a109f…c45e59f` — byte-identical to the Dell's). Without it
P0-8 could not be taken at all. That volume is `x-nova-backup:
exclude-redownload`, so it is not carried by a backup and the pull costs
nothing at move time.

### P0-8: the embedder on the N150 (mini PC vs Dell)

**How the stack authenticates, checked rather than guessed.** The memory
service takes `Authorization: Bearer $SERVICE_TOKEN`
(`services/memory/app/auth.py:19-30`), fed from `CORE_MEMORY_TOKEN` in
`deploy/.env` (`deploy/docker-compose.yml`, the `memory` service). The live
value was read back from the running container, not from a guess:

```
docker inspect nova-memory-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^SERVICE_TOKEN=//p'      # 64 hex chars, on BOTH hosts
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8002/recall \
  -H 'Content-Type: application/json' -d '{"query":"graphics memory","person_id":"probe","k":3}'
#   -> 401   (no token)
#   -> 200   with -H "Authorization: Bearer $TOK", 3 runs, 0.044-0.070 s   [both hosts]
```

Authentication works on both. **The latency itself was then measured one
layer down, at `POST <ollama>/api/embed`** — the call the service actually
makes (`services/memory/app/embedding.py:456-479`), with the service's own
body (`truncate:false`, `keep_alive:5400`) — because that is where the N150
cost lives and it isolates the reading from corpus size. The service-name
path was confirmed to be the same one: from inside `nova-memory-1` on the
mini PC, `http://ollama:11434/api/embed` answered 768 dimensions in 43-57 ms
for a 5-token input, 3 runs.

**Latency, 25 sequential single-text calls of ~40 tokens, warm model**
(`scratchpad/p0-8-embed.py <label> <run>`; the cold warm-up call is excluded):

| Host | run | p50 ms | p90 ms | min | max |
|---|---|---|---|---|---|
| Dell, 3090/CUDA | 1 | 8.18 | 9.48 | 7.21 | 99.95 |
| Dell | 2 | 26.93 | 31.95 | 14.88 | 78.56 |
| Dell | 3 | 9.50 | 10.79 | 8.33 | 11.91 |
| Dell | 4 | 27.46 | 34.83 | 15.13 | 75.78 |
| Dell | 5 | 9.09 | 10.36 | 8.28 | 12.07 |
| Dell | 6 | 9.43 | 11.01 | 8.83 | 11.91 |
| **Dell, median of 6 runs** | | **9.47** | **10.90** | | |
| mini PC, N150/CPU | 1 | 152.19 | 161.45 | 150.17 | 237.56 |
| mini PC | 2 | 152.10 | 198.59 | 150.37 | 332.56 |
| mini PC | 3 | 152.38 | 206.31 | 149.98 | 354.59 |
| **mini PC, median of 3 runs** | | **152.19** | **198.59** | | |

**≈ 16× slower at 40 tokens.** The Dell's six runs are bimodal (four near
9 ms, two near 27 ms) with the GPU at 0-2 % and 2.1 GiB used throughout;
the cause was **not** established and is recorded as unexplained. It does
not move the branch.

Cold load (first call after the model is unloaded): Dell `load_duration`
**1065 ms**, mini PC **528 ms** — the CPU host loads *faster*, because
there is no host-to-VRAM copy.

**Latency vs input length is the reading that actually matters**
(`scratchpad/p0-8-sweep.py`, 9 calls per row, warm, p50/p90 ms;
`prompt_eval_count` confirms the token count reached the model):

| approx tokens | Dell p50 | Dell p90 | mini p50 | mini p90 | ratio (p50) |
|---|---|---|---|---|---|
| 8 | 26.1 | 35.2 | 51.5 | 139.6 | 2.0× |
| 40 | 27.7 | 29.2 | 175.9 | 184.6 | 6.4× |
| 200 | 23.9 | 25.6 | 866.0 | 907.8 | 36× |
| 800 | 54.7 | 57.4 | 3 670.4 | 3 724.9 | 67× |
| 2000 (model context is 2048) | 36.9 | 44.9 | **10 301.2** | 10 375.3 | **279×** |

The 3090 is flat in input length. The N150 is **purely linear at
5.15 ms/token** ((10301.2 − 51.5) / (2002 − 10)) with no measurable fixed
overhead.

**Against the code's own budgets** (`embedding.py`: `CORE_RECALL_TIMEOUT`
2.0 − `RECALL_RESERVE` 0.4 = **`DEFAULT_QUERY_TIMEOUT` 1.6 s**;
`DEFAULT_TIMEOUT` 30 s; `DEFAULT_BATCH` 8):

- **Query side is fine, with a stated ceiling.** 1.6 s / 5.15 ms ≈ **311
  tokens**. A question up to ~300 tokens embeds inside the budget on the
  N150 (200 tokens costs 908 ms at p90, 57 % of it). Past that the call
  times out and recall falls back to lexical *and says so* — the honest
  path already exists, but it becomes reachable by a long question, which
  it is not on the Dell.
- **Backfill side has a cliff.** `scratchpad/p0-8-batch.py`, 3 runs each,
  median, against the 30 s `DEFAULT_TIMEOUT`:

| batch × tokens | Dell median | mini PC median | vs 30 s |
|---|---|---|---|
| 8 × 200 | 47 ms | 7 298 ms | fits |
| 8 × 800 | 92 ms | **29 431 ms** | fits by **0.6 s** |
| 8 × 2000 | 268 ms | **83 566 ms** | **2.8× over** |
| 1 × 2000 | 39 ms | 10 455 ms | fits |

  8 × 2000 takes 83.6 s on the N150 against 8 × 10.45 s = 83.6 s
  sequentially — **batching buys exactly nothing on CPU** (on the GPU it
  buys 1.2×). So `DEFAULT_BATCH = 8` on a CPU hub is pure timeout risk for
  no throughput. `truncate:false` plus a chunker that can reach the 2048
  context makes this fire, not a theoretical case.

**Cosine parity.** Six fixed strings (including the empty string and a
1 200-character run of `a`), embedded on both hosts, 3 runs each,
compared element-wise (`scratchpad/p0-8-parity.py`):

- **Within a host: bit-identical.** 18/18 Dell pairs and 12/12 mini PC
  pairs were exactly equal, worst element delta `0.000e+00`.
- **Across hosts: not identical, but far below the signal.** Worst cosine
  over all 9 cross-host run pairs per text was **0.99998820** (text: 1 200×
  `a`); the others 0.99998999-0.99999985. Worst element delta
  **5.4 × 10⁻⁴**.
- For scale: on the Dell alone, the *closest pair of distinct texts* sits
  at cosine 0.5450, i.e. `1 − cos = 4.55e-01`. The cross-host disagreement
  for the *same* text is `1.18e-05` — **38 500× smaller than the nearest
  real separation.**

**Branch.** *Re-derive the budgets; do NOT re-embed.*

1. **No re-embed.** The vector cache is `/data/memory/.embeddings/nomic-embed-text.jsonl`
   (182 lines, 771 KB, keys `f h d v`) inside `v4_memdata`, which
   `deploy/docker-compose.yml` already marks `x-nova-backup: include`.
   Vectors written on the Dell and read on the N150 differ by ~1e-5 in
   cosine, four orders of magnitude below the smallest gap the ranker has
   to resolve. It rides along as designed and S45 needs no re-embed step.
   (The Dell corpus is 98 notes / 229 KB; a full re-embed would cost about
   5 min on the N150 at 5.15 ms/token if it were ever wanted.)
2. **S45's move sets `MEMORY_EMBED_BATCH=1` on a CPU hub.** It costs no
   throughput (measured: perfectly linear) and removes the 30 s cliff
   entirely — worst single call is 10.5 s. Raising `MEMORY_EMBED_TIMEOUT`
   instead would keep a 29.4 s call that is 98 % of its budget.
3. **`MEMORY_EMBED_QUERY_TIMEOUT` stays at its derived 1.6 s**, with the
   stated ceiling that a question over ~300 tokens will fall back to
   lexical on a CPU hub. The fallback already announces itself; nothing new
   is owed beyond writing the ceiling down.
4. S45 walk step 7's check — "the embedder returns 768 dimensions" — passes
   on the N150. Confirmed, both hosts, `dim = 768`.

### P0-9 (the rest): the logind inhibitor from a linger user unit (mini PC)

**Measured.** `Linger=yes` for uid 1000 was already true. The probe
(`/tmp/p0-9-probe.sh`) starts each inhibitor as a **transient user unit**,
i.e. in `user-1000.slice` and *not* in any session scope — which is exactly
what a linger-started Nova unit is:

```
systemd-run --user --unit=p0-9-<what>-<mode> --collect \
  systemd-inhibit --what=<what> --mode=<mode> --who="P0-9 probe" --why="hub P0-9" \
  /bin/sleep 45
```

| `--what` | `--mode` | Result |
|---|---|---|
| `sleep` | `block` | **`Failed to inhibit: Access denied`**, unit exits 1 |
| `idle` | `block` | **granted** — appears in `systemd-inhibit --list` |
| `sleep` | `delay` | **granted** |
| `sleep:idle` | `block` | **`Access denied`** — the *whole* request fails; the idle half is not granted either |

**Why**, read from polkit rather than inferred
(`pkaction --action-id … --verbose`):

| action | implicit **any** | inactive | active |
|---|---|---|---|
| `org.freedesktop.login1.inhibit-block-sleep` | **no** | yes | yes |
| `org.freedesktop.login1.inhibit-block-idle` | **yes** | yes | yes |
| `org.freedesktop.login1.inhibit-delay-sleep` | **yes** | yes | yes |

A unit under linger has no session, so polkit judges it under **`any`** —
and `inhibit-block-sleep` is the one of the three whose `any` is `no`. This
is a property of the default policy, not of this machine.

**It survives logout.** An `idle`/`block` inhibitor started as
`p0-9-linger.service`, then the SSH session closed and a *new* one opened:
the unit is still `active` and the inhibitor is still in
`systemd-inhibit --list` with the new session's own id absent from it.

**The desktop's auto-suspend could not be exercised, and here is why.**
There is no graphical session logged in on that machine at all — the only
`loginctl` session during every probe was my own Tailscale SSH one. So
"does the desktop honour it" has no live subject. What is readable instead:
`gsettings … sleep-inactive-ac-type` = `'nothing'` (timeout 900), and
logind's effective config is `IdleAction=ignore` / `IdleActionSec=infinity`
(`systemd-analyze cat-config systemd/logind.conf`). **Nothing on that host
is currently configured to auto-suspend on AC**, so there is nothing for an
idle inhibitor to override today. Making this takeable needs a graphical
login plus `sleep-inactive-ac-type` set to `suspend` — an owner action, and
one that would put the hub to sleep, so it was not done.

**Branch.** *`internal/hold/linux` takes two inhibitors, not one, and never
a combined one. No polkit rule is needed for the case Nova actually has.*

1. Take `--what=idle --mode=block` **and**, separately,
   `--what=sleep --mode=delay`. A single `--what=sleep:idle --mode=block`
   is refused **outright** — measured — so the obvious one-call
   implementation silently loses the idle inhibitor too. That is the
   failure this row exists to catch.
2. `--what=sleep --mode=block` **is refused for a linger unit and will
   stay refused.** The hold must therefore report what it actually holds:
   "idle suspend is inhibited" is true; "the machine will not sleep" is
   not. A `hold` that returns success on an `idle` grant while claiming
   sleep is held is exactly the "report success you did not check" defect.
3. The one-line polkit rule stays **parked, not needed yet**: it would only
   buy blocking an *explicit* `systemctl suspend`, which nothing on this
   host issues. If S44 later needs it, it is a
   `/etc/polkit-1/rules.d/*.rules` granting `inhibit-block-sleep` to uid
   1000 — an owner action, written down before it is asked for.

### P0-16/17 (per runtime): what Ollama says about its own compute

**Measured on both.** Same ollama **0.33.1**, same model digest
`0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, same
`context_length` 2048.

```
docker logs nova-ollama-1 2>&1 | grep 'msg="inference compute"' | tail -1
curl -s http://127.0.0.1:11434/api/ps
```

| | Dell (`nova-ollama-1`, 3090) | mini PC (`nova-ollama-1`, N150) |
|---|---|---|
| `inference compute` | `id=0 filter_id=0 library=CUDA compute=8.6 name=CUDA0 description="NVIDIA GeForce RTX 3090" libdirs=ollama,cuda_v13 driver=13.3 pci_id=0000:01:00.0 type=discrete total="24.0 GiB" available="22.8 GiB"` | `id=cpu library=cpu compute="" name=cpu description=cpu libdirs=ollama driver="" pci_id="" type="" total="15.4 GiB" available="15.3 GiB"` |
| `llama.cpp` device line | `- CUDA0 : NVIDIA GeForce RTX 3090 (24575 MiB, 23300 MiB free)` | `- CPU : Intel(R) N150 (15767 MiB, 15767 MiB free)` |
| threads | `n_threads = 10 / 20` | `n_threads = 4 / 4` |
| `/api/ps` `size` (same model) | **323 150 151** | **376 449 269** |
| `/api/ps` `size_vram` | **323 150 151** (all of it) | **0** |

**The compute identity is readable without guessing, from two sources with
different reach.** Over HTTP, `/api/ps.size_vram` settles GPU vs CPU
mechanically: `> 0` is a GPU runtime, `0` is CPU, no string matching. It
does **not** say *which* device — there is no device endpoint at all in
0.33.1 (`/api/devices`, `/api/gpu`, `/api/info` all 404; `/api/show` is 405
on GET). The library, card name and bus id come only from the startup log
line, and the UUID only from `nvidia-smi` in a container with the device,
which still reads as `GPU-<redacted-36-char-uuid>` (shape confirmed; value
never recorded, per this file's rule).

**Branch.** *A fit measurement does not carry across runtimes; the compute
stamp is derivable on both.*

1. **Fit is per-runtime, and the runtime's own numbers say so.** The *same
   model blob* reports 323 MB on CUDA and 376 MB on CPU — a 16.5 %
   difference, in `/api/ps`, for one digest. S45 must therefore not reuse a
   `dell:` fit reading for a `mini:` engine, nor the reverse. This is
   narrower than P0-17's 09-18 finding, which only established that
   `dell:`-stamped probes survive the *Dell's own* move between vantage
   points — that still holds and is untouched.
2. **The stamp for a CPU engine is `cpu:<something>`, not an absent
   stamp.** The log line gives `library=cpu` and the llama.cpp line gives
   `Intel(R) N150`; neither carries a UUID and neither ever will, so the
   S40 `gpu:cuda:<uuid>` shape has no CPU analogue. S44's `internal/compute`
   should derive the CPU key from a stable host fact (`/proc/cpuinfo` model
   name plus core count), and state "no stable device key" rather than
   omitting the stamp silently.
3. **`size_vram` is the mechanical check** for "is this engine actually on
   the GPU it claims" — cheaper and more honest than parsing a log line,
   and it is the one that catches a 3090 host that quietly fell back to
   CPU after a resume (which is what P0-4 will look for).

### P0-15/18 (the Linux half): container → a listener on the host

**Measured on the mini PC** (Linux, no Docker Desktop). Two throwaway
listeners, one bound to loopback and one to all interfaces, then probed
from `--rm` containers on each network (`/tmp/p0-15-probe.sh`):

```
python3 -m http.server 19911 --bind 127.0.0.1     # the default an app picks
python3 -m http.server 19912 --bind 0.0.0.0
docker run --rm --network=<net> redis:7-alpine wget -q -T 3 -O /dev/null http://<target>:<port>/
```

| from | target | :19911 (host bound `127.0.0.1`) | :19912 (host bound `0.0.0.0`) |
|---|---|---|---|
| default `bridge` | `172.17.0.1` (gateway) | **refused** | **reached** |
| `nova_default` | `172.18.0.1` (gateway) | **refused** | **reached** |
| `--add-host=…:host-gateway` | `host.docker.internal` → `172.17.0.1` | **refused** | **reached** |
| default `bridge` | `100.71.168.83` (tailnet) | **refused** | **reached** |
| default `bridge` | `192.168.0.245` (LAN) | **refused** | **reached** |
| `--network=host` | `127.0.0.1` | **reached** | — |

And from the **live `nova-gateway-1`** container, which is the one that
would front a native host Ollama (read-only `docker exec … python3 -c`):
`172.18.0.1:19911` → `ConnectionRefusedError`; `172.18.0.1:19912` →
reached; bare `host.docker.internal` → `gaierror` (**Linux does not provide
the alias without `--add-host`; Docker Desktop does**).

`/proc/sys/net/ipv4/conf/{docker0,all}/route_localnet` = **0** on that host,
which is why the loopback-bound listener is refused rather than timing out:
the packet reaches the host and is rejected, it is not dropped.

**Firewall.** `systemctl is-active ufw` → **`active`** while
`ufw status` → **`Status: inactive`** — the *unit* is running and enabled,
the *firewall* is not enforcing. `iptables -S DOCKER-USER` holds only the
chain declaration, no rules. **So nothing needs a rule today**, and a check
that reads `systemctl is-active ufw` to decide would get the wrong answer;
`ufw status` is the fact.

**Branch.** *Bind choice, not a firewall rule.*

1. **A native Ollama on a Linux hub must be told to bind wide** —
   `OLLAMA_HOST=0.0.0.0:11434` (the same fix already recorded in
   `ollama-container-shadows-host`). Its default `127.0.0.1` is
   **unreachable from every container**, on every network, by every
   address, and it fails as a connection *refusal*, which is easy to
   misread as "ollama is down" rather than "ollama is bound narrow". S44's
   models role should say which of the two it found.
2. **Address the host as the network's own gateway, derived**, not as a
   literal. `host.docker.internal` requires
   `--add-host=host.docker.internal:host-gateway` on Linux — fine, but it
   resolves to `172.17.0.1` (the *default* bridge) even for a container on
   `nova_default/172.18.0.1`, so it is not the network's gateway. Read the
   gateway from `docker network inspect <net> -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`.
   This matters because S41's `decide_subnet` moves the subnet.
3. **The ufw rule is written down but not needed, and not measured
   enabled.** ufw was left off; enabling his firewall over the only SSH
   path to the machine was out of scope. If it is ever enabled with the
   default deny-incoming, the rule would have to allow the docker subnet
   to the host port — and it must name the **subnet**, not the bridge
   interface: nova's bridge is `br-dccfe5974658`, a name derived from the
   network id that changes every time the network is recreated. A rule
   pinned to that interface name is a control that breaks on the next
   `compose down`.
4. The Dell/Docker-Desktop half of this row (P0-18) was already taken
   2026-09-18 and is unchanged.

### Not taken, and what would make each takeable

| ID | Why not | What it needs |
|---|---|---|
| P0-9, "does the desktop honour the idle inhibitor" | No graphical session is logged in on the mini PC — the only `loginctl` session during every probe was the SSH one — and `sleep-inactive-ac-type` is `'nothing'` with `IdleAction=ignore`, so there is nothing configured to suspend | An owner graphical login with `sleep-inactive-ac-type=suspend` and a short timeout. It would put the hub to sleep, so it is an owner call |
| P0-8, end-to-end `/recall` against the real corpus on the Dell | The step that would have named a real `person_id` reads his notes; it was refused and not worked around | Not needed for the branch — the embed boundary was measured directly, which is where the N150 cost is |
| P0-10 (longest silence in a pull) | The only pull taken was `nomic-embed-text`, 274 MB in 8.5 s — far too small to say anything about a silence window, and `/api/pull`'s NDJSON carries no timestamps | A multi-GB pull with per-line arrival times recorded by the client |
