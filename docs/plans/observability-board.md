# Observability board + system monitoring — plan (NOT approved, no code yet)

Implementation plan authored 2026-07-22 at Jeremy's request: "review the
audit/trace features, decide if we should build a dedicated board of
observability, and start implementing resource monitoring (disk, VRAM/RAM,
CPU)." Revised the same day after Jeremy added the load-bearing constraint:
**Nova may become a distributed system** — DB on one device/cloud,
chat/agents on another, model storage on another, memory on another
device/cloud. The design below is **instance-aware from day one** so a
single box today is just a one-instance fleet, and multi-instance rides in
for free rather than as a rewrite.

Scope forks (answered by Jeremy):

- **Monitoring depth:** full, **phased** — live gauges (P1) → rolling
  history (P2) → threshold alerts (P3).
- **Placement:** a **dedicated top-level Observability panel** (its own
  launcher, peer to Settings), not a Settings sub-section.
- **Topology:** instance-attributed metrics; aligns with — and partly
  co-owns identity/leader plumbing with — `remote-shared-state.md`.

Everything else is a recommendation open to pushback; decisions that are
genuinely Jeremy's are flagged at the bottom.

> **Not this plan:** `device-activity-monitoring.md` monitors *Jeremy's own
> devices* (ActivityWatch / Screen Time — what apps he uses) for Nova's
> awareness. This plan monitors *the machines Nova runs on* (CPU/RAM/VRAM/
> disk + service health + turn/cost rollups). Different subjects.

## What exists (verified in code, 2026-07-22)

- **Turn ledger (ROADMAP #3, complete + live).** `backend/app/trace.py`
  writes one `turn_traces` row per turn + nested `turn_spans`
  (`stage`/`llm_call`/`tool`/`dispatch`) across `chat`/`automation`/
  `compaction`. Secrets redacted; spans buffer and flush once, fire-and-
  forget, so tracing never adds latency. Schema `028_turn_traces.sql`;
  daily retention via `trace.retention_days` (default 14).
- **`llm_call` spans already carry token counts.** `runner.py:372-375`
  stamps `prompt_tokens`/`completion_tokens` from the provider `usage`
  chunk (`include_usage=True`, works on OpenRouter AND local Ollama).
  **The cost/token rollup reads existing data — nothing new to capture.**
- **Trace API + UI.** `GET /api/v1/traces`, `/traces/{id}`;
  `chat/TurnInspector.tsx`; `components/RecentTurns.tsx` in Settings →
  Observability.
- **Hardware detection (capacity, on demand, per host).**
  `backend/app/hardware.py` — RAM total, CPU cores, platform, GPU presence +
  total VRAM. **Capacity, never utilization**, and it describes *this
  instance's* host.
- **The inference-control sidecar** (`inference-control/server.py`) is a
  per-host, fixed-verb HTTP service that runs docker/nvidia-smi locally:
  `/gpu`, `/vram`. **`remote-shared-state.md` keeps the sidecar and local
  inference per-instance by design** — so every instance already ships its
  own host agent. No new agent to build; extend the verbs.
- **Distributed model is already specced.** `remote-shared-state.md`: central
  PG + memory (`DATABASE_URL`/`NOVA_MEMORY_DIR`), per-instance inference,
  **leader election via `pg_try_advisory_lock`** (`backend/app/leader.py`,
  not built yet) to keep singleton background work single-run, and a
  Settings → Storage card meant to show "shared/leader" topology.
- **Notification registry (#21, shipped).** `notify_operator` + modular
  providers + the scheduler auto-disable alert. **Alerts (P3) reuse this.**
- **`/health`** is only a DB ping — no service-up matrix (the ledger memory
  note: "service-health surface still unbuilt").
- **Frontend has `d3` (^7.8.5)** — sparklines need no new dep — and a
  `MemoryBar` gauge component (`SettingsOverlay.tsx:1024`). Reuse both.

## Design: consolidate over a shared DB, attribute everything to an instance

One new top-level **Observability** panel. Four sections:

1. **Health / topology strip** — per-instance up/down + which shared
   backends (central PG, memory dir, model store) each instance reaches, and
   who holds the leader lock.
2. **Resources** — live gauges for *this* instance (CPU%, RAM, VRAM
   used/total, GPU util+temp, disk) reusing `MemoryBar`; a **fleet table**
   of every instance's latest reading; sparklines (P2).
3. **Turns & cost** — 24h rollups over the ledger (turns, error rate,
   p50/p95, tokens + est. cost, model breakdown, **and which instance
   served them**); hosts the relocated RecentTurns + TurnInspector.
4. **Alerts** (P3) — active alerts (node-attributed) + threshold editor.

No OpenTelemetry, no Prometheus, no TimescaleDB. Single operator; one narrow
table + plain Postgres aggregation is enough.

### Distributed topology (instance-aware from day one)

The unit of monitoring is an **instance**: a Nova backend on a machine.
Per `remote-shared-state.md`, instances share one DB + memory but keep their
own inference/GPU/disk/sidecar — so hardware metrics are inherently
per-instance, and the shared DB is the natural rendezvous.

**The shared DB is the aggregator — no central metrics collector, no
cross-node fan-out.** Each instance samples *its own* host (local `/proc` +
its local sidecar) and writes rows tagged with its `instance_id` into the
shared DB. Any instance serving the board reads all instances back out. This
is why distribution costs almost nothing here: it falls out of the central
PG that `remote-shared-state.md` already establishes.

Consequences that shape the design:

- **Live vs. fleet.** P1's live gauges are *local-direct* (the instance you
  are connected to — correct and instant). The **fleet view** of other
  instances comes from their latest DB samples (P2), a few seconds stale —
  good enough; it avoids live HTTP fan-out to remote nodes.
- **We monitor only what an instance can see.** Its own host (full metrics),
  plus resources it *touches* — a mounted model store or memory dir (report
  `disk_usage` of the mount) and shared backends (reachability + round-trip
  latency). A black-box **cloud** DB/bucket exposes no host metrics to us:
  for those, "health" = reachability + latency, which the **ledger already
  measures** (a `db`/`memory`/`llm_call` span's duration IS the link signal
  — reuse it, don't add pings).
- **Leader-gate the singletons, not the sampling.** Every instance samples
  itself (not leader-gated — each reports its own hardware). Only
  **retention prune** and **alert evaluation/de-dupe** are leader-gated
  (via `leader.is_leader()` from `remote-shared-state` phase 1) so they run
  once across the fleet. The leader evaluates alerts over everyone's samples
  in the shared DB, and a stale heartbeat from an instance becomes an
  "instance unreachable" alert.
- **Identity is co-owned with `remote-shared-state.md`.** Both need a stable
  `instance_id` + human label + role. Define it once; whichever lands first
  owns it, the other consumes it. The health/topology strip here and the
  "Settings → Storage shows shared/leader status" item there are the **same
  surface** — build it once.

### Where each metric comes from (each instance, about itself)

| Metric | Source (local to the instance) |
|---|---|
| CPU% / load avg | `/proc/stat` deltas (or `psutil`) |
| RAM used/total | `/proc/meminfo` MemTotal − MemAvailable |
| Disk used/total | `shutil.disk_usage` on mounted paths (incl. memory dir / model-store mounts) |
| VRAM used/total, GPU util%, temp | its local sidecar — **new `/gpu-stats`** |
| Per-container CPU/mem + up/down | its local sidecar — **new `/containers`** |
| Model-store disk + `docker system df` | its local sidecar — **new `/disk`** |
| Shared-backend reachability + latency | ledger spans (`db`/`memory`) + a cheap connect check |
| Turn/cost rollups | aggregate shared `turn_traces`/`turn_spans` |

Honest platform note (WSL2): a backend container sees the **WSL2/Docker VM**,
not the Windows host — which is the real ceiling that constrains that
instance (same stance `hardware.py` takes). Label gauges as VM/instance
metrics.

### New sidecar verbs (fixed commands, same pattern as `/gpu`, `/vram`)

Added to every instance's local sidecar; each backend calls its own.

- `GET /gpu-stats` → `{gpus:[{name, mem_used_gb, mem_total_gb, util_pct,
  temp_c}]}` — `nvidia-smi --query-gpu=name,memory.used,memory.total,
  utilization.gpu,temperature.gpu --format=csv,noheader,nounits`. Fails soft
  (CPU-only → `{gpus:[]}`).
- `GET /containers` → per-service `{name, state, cpu_pct, mem_used_gb,
  mem_total_gb}` from `docker compose ps --format json` +
  `docker stats --no-stream --format json`.
- `GET /disk` → `{model_store:{path, free_gb, total_gb}, docker:{images_gb,
  volumes_gb, build_cache_gb}}` from `shutil.disk_usage` + `docker system
  df --format json`.

Nothing parameterized — same fixed-verb safety contract.

### Data model (P2 — new migration)

Pick the next free migration number by reading the dir at build time — it
keeps moving with parallel work (043/044 were already taken by other lanes
by 2026-07-22, so 043 in this plan's earlier drafts is STALE; next free was
045 then). Instance-tagged from the start:

```sql
-- Stable identity for a Nova backend on a machine. Co-owned with
-- remote-shared-state.md; upserted (last_seen) on each sample. Optional if
-- that plan lands identity first — then just reference its table.
CREATE TABLE IF NOT EXISTS instances (
  id          TEXT PRIMARY KEY,        -- persisted uuid (control file) or hostname
  label       TEXT,                    -- human name ("work laptop")
  role        TEXT,                    -- hint: 'inference' | 'db' | 'memory' | 'all'
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaches     JSONB NOT NULL DEFAULT '{}'  -- {pg:{ok,ms}, memory:{ok,ms}, ...}
);

CREATE TABLE IF NOT EXISTS resource_samples (
  instance_id    TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  cpu_pct        REAL,
  load1          REAL,
  mem_used_gb    REAL,
  mem_total_gb   REAL,
  vram_used_gb   REAL,
  vram_total_gb  REAL,
  gpu_pct        REAL,
  gpu_temp_c     REAL,
  disk_used_gb   REAL,
  disk_total_gb  REAL,
  detail         JSONB NOT NULL DEFAULT '{}'  -- per-container / per-disk breakdown
);
CREATE INDEX IF NOT EXISTS resource_samples_inst_ts_idx
  ON resource_samples (instance_id, ts DESC);
```

Also add `instance_id TEXT` to `turn_traces` (stamped at turn open) so
rollups break down by which "muscle" served the turn — a one-column,
back-compatible add. Diagnostics only; prune freely.

Per-instance heartbeat is just `max(ts) GROUP BY instance_id` (or
`instances.last_seen`) — no separate table.

### Sampler + retention

Each instance runs a sampler on its **own** scheduler tick, throttled ~60s
(the `trace.maybe_prune` monotonic-gate pattern) — **not** leader-gated. One
row per tick, upserting `instances.last_seen` + `reaches`. **Retention prune
is leader-gated** (`monitor.retention_days`, default 7; daily). 60s × 7d ×
N-instances is still trivial; chart downsampling is plain Postgres bucketing
(`date_bin` averages), no extension.

### Endpoints (backend)

- `GET /api/v1/system/resources` — *this instance's* live snapshot: local
  `/proc`/disk + its sidecar `/gpu-stats`,`/containers`,`/disk`. Board polls
  ~3–5s. **(P1)**
- `GET /api/v1/system/fleet` — every instance's latest sample + heartbeat +
  `reaches` + leader flag. Renders the fleet table and health/topology strip.
  Single-instance today = one row. **(P1 shape; populated richly at P2)**
- `GET /api/v1/observability/summary?window=24h[&instance=]` — ledger
  rollups (turns, error rate, p50/p95, tokens, est. cost), optionally per
  instance. **(P1 — pure aggregation over existing tables.)**
- `GET /api/v1/system/resources/history?window=1h|24h|7d[&instance=]` —
  bucketed series from `resource_samples`. **(P2)**
- `GET/PUT /api/v1/system/alerts` (+ thresholds). **(P3)**

Cost = token totals × a per-model price map (curated, operator-editable;
local = $0, cloud = "est.").

### Alerting (P3)

`monitor.thresholds` (disk_pct, mem_pct, vram_pct sustained, gpu_temp_c,
**instance-unreachable** = stale heartbeat), evaluated **on the leader only**
over the shared samples, with debounce/hysteresis so a hovering value can't
storm. On breach → `notify_operator` and/or a recommendation card,
**node-attributed** ("VRAM saturated on *work-laptop*", "central PG
unreachable from *home-desktop*"); auto-clear + de-dupe on recovery. Mirrors
the shipped scheduler auto-disable alert.

### Frontend

New top-level **Observability** launcher (peer to Settings). Reuse
`MemoryBar` for used/total gauges; d3 scales for SVG sparklines (P2); an
instance switcher / fleet table (collapses to one instance today). Relocate
`RecentTurns` + `TurnInspector` into "Turns & cost"; Settings → Observability
collapses to a one-line link (discoverable per "walk the click path").
Verify via `frontend-visual-verification` at :5173 (+ rebuild `web` for
:8080).

## Phases (one per session; hold to the verification line)

- **Phase 1 — Live board, single instance (no storage). BUILT 2026-07-22,
  uncommitted, live-verified at :5173.** Sidecar verbs
  (`/gpu-stats`,`/containers`,`/disk`); backend `/system/resources`,
  `/system/fleet` (one row), `/system/health`, `/observability/summary`; the
  Observability panel with health strip, live gauges, per-container table, 24h
  turn/cost cards + by-model cost, relocated RecentTurns. Instance identity
  established (per-host id in `/state`, trivial `is_leader()`). Chose dep-free
  `/proc`+`shutil` over psutil (decision #2) to avoid an image rebuild —
  trivial later swap. Verified live: RTX 3090 VRAM 7.3/24 GB + 66%/67°C,
  per-container CPU/mem, health chips with latencies, $1.35 est cost on
  glm-5.2 (locals $0), poll ticking (42→43 turns between shots).
- **Phase 2 — History + fleet.** Migration 043 (`instances`,
  `resource_samples`, `turn_traces.instance_id`); per-instance sampler
  (tick, ~60s) + **leader-gated** prune; `/system/resources/history`
  bucketed; SVG sparklines + 1h/24h/7d toggle; the fleet table now populated
  from DB samples. **This is what makes multi-instance work** — no new
  collector, just tagged rows in the shared DB. **Verify (single box):**
  history fills and survives `docker compose up -d backend`. **Verify
  (multi, when available / via a second backend on the same PG):** a second
  instance appears in the fleet with its own gauges and heartbeat.
- **Phase 3 — Alerts.** `monitor.thresholds` + **leader-only** evaluation
  with debounce/hysteresis; route through `notify_operator` / recommendation
  surface, node-attributed; active-alerts UI + threshold editor. **Verify:**
  set disk threshold to 1% → exactly one ntfy + one card (not a storm);
  raise it back → auto-clears; stop a second instance's sampler → an
  "unreachable" alert fires from the leader.

## Reuse / align (don't rebuild)

- **Ledger** for turn/cost (tokens already in `llm_call` spans) and for
  inter-node link health (span durations).
- **Sidecar fixed-verb pattern**, per instance — extend `/gpu`,`/vram`.
- **`leader.py` + instance identity + the topology card** from
  `remote-shared-state.md` — co-own, don't duplicate. Monitoring's health
  strip *is* that topology card.
- **`MemoryBar`** for gauges; **`d3`** for sparklines;
  **`RecentTurns`/`TurnInspector`** relocated, not rewritten.
- **Notification registry (#21)** for alerts; retention/prune pattern from
  `trace.maybe_prune`.

## Decisions flagged for Jeremy

1. **Sequencing vs. `remote-shared-state.md`.** The instance-identity + leader
   seam is shared. Cleanest order: land `remote-shared-state` **phase 1
   (leader election, a standalone win)** first, then build this on top; OR
   this plan defines a minimal `instance_id` and a no-op `is_leader()→True`
   for single-node, and remote-shared-state adopts it. **Recommendation:**
   the minimal shared identity ships in **P1 here** (works single-node with a
   trivial leader), and leader election proper arrives with remote-shared-
   state — the monitoring code checks `is_leader()` from the start so nothing
   changes when real election lands.
2. **`psutil` vs. hand-rolled `/proc`.** Recommend `psutil` (correct CPU%
   deltas + mem + disk + load in one call) over bespoke `/proc/stat` math;
   counter is that `hardware.py` is deliberately dep-free. **Recommendation:
   psutil.**
3. **VM/instance vs. host metrics on WSL2.** Recommend monitoring the
   VM/instance (the real ceiling); Windows-host totals need a separate host
   agent — out of scope.
4. **Sampling cadence + retention** — proposed 60s / 7 days.
5. **Cost price map** — curated, operator-editable table (like
   `curated_models`), local = $0, cloud = "est."; confirm approximate cost is
   worth it vs. tokens-only.
