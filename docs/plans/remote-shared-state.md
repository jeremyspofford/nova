# Remote shared state — one brain, many machines

Implementation plan (authored 2026-07-15 with Fable). Direction set
2026-07-14 (feasible, three engineering points). Use case: Jeremy's
personal + work computers run Nova instances that ARE the same entity —
central postgres + memory, per-instance inference ("same brain, different
muscles"). Until this ships, the supported answer stays: one instance +
tailnet PWA from every device.

## The three engineering points (from the 2026-07-14 design note)

1. **Remote postgres — already works, needs docs + a health surface.**
   `DATABASE_URL` is env-driven; point secondary instances at one PG over
   the tailnet. Per-turn latency over WireGuard is fine. The local
   `postgres` service simply goes unused on secondaries (compose profile
   it so it can be disabled: move `postgres` under a `local-db` profile
   defaulted on — breaking change is fine, pre-release).

2. **Shared memory dir — the BM25 index is the gap.** `NOVA_MEMORY_DIR`
   on NFS/SMB works today EXCEPT: each instance's index is in-process and
   only rescans at startup, so instance B sees A's new memories only
   after restart. Build the **file watcher** (also wanted by the
   memory-sync-pipeline item — one watcher serves both):
   - watchfiles-based task in the backend, watching the memory root;
     debounce 500 ms; on change reindex the changed file only (the index
     already reindexes on its own writes — reuse that path).
   - NFS/SMB caveat: inotify does NOT propagate over network mounts —
     the watcher must fall back to a mtime-scan poll (every 30 s) when
     the dir looks remote or inotify goes quiet. Detect: compare a
     touch-file's inotify event vs. poll observation at startup; or just
     always run the poll as belt-and-braces (it's cheap at our scale).
   - Concurrent same-file writes (both instances appending today's
     journal): per-file advisory lock is NOT reliable on network mounts —
     accept last-writer-wins for now and make appends atomic
     (write-temp + rename) so files never interleave/corrupt. Document
     the limit.

3. **Singleton background work — leader election.** With two backends on
   one DB, the automations scheduler, model warmer, compaction, and any
   retention jobs would double-run. Use a **postgres advisory lock**:
   - `SELECT pg_try_advisory_lock(0x4E4F5641)` ('NOVA') on a dedicated
     connection at startup; holder = leader, runs the singleton loops;
     non-holders poll every 30 s to take over if the leader dies (the
     lock auto-releases when its session drops — that's the beauty).
   - Implement as `backend/app/leader.py` with `is_leader()` +
     `on_promoted` hooks; scheduler/warmer/compaction check it before
     each cycle (NOT once at startup — leadership can move).
   - This phase is safe and useful standalone (a restarting single
     instance can never double-run either).

## What stays per-instance (by design — do not centralize)

Local inference (ollama + named endpoints), hardware.json/GPU detection,
the tailscale sidecar, settings that are host-facts. Settings in
`settings_store` are DB-backed → automatically shared; audit for any
host-specific keys and move those to env (there's a known config-
fragmentation footgun — worth the audit pass regardless).

## Phases

1. **Leader election. BUILT + VERIFIED 2026-07-23, uncommitted** (built as
   the prerequisite for observability-board P3 alerts). `backend/app/
   leader.py`: dedicated asyncpg connection, `pg_try_advisory_lock
   (0x4E4F5641)`, 30s retry, fail-safe demotion on any connection doubt,
   `on_promoted` hooks; started in lifespan BEFORE the scheduler so a
   single instance leads from tick one; `instances.is_leader()` now
   delegates (all observability gating switched over untouched).
   Scheduler singletons (automations, trace prune, sample prune, alert
   eval) gate per-tick; sampling stays per-instance. The split-state
   startup refusal (Traps below) also landed (`_refuse_split_state` in
   main.py, `NOVA_ALLOW_SPLIT_STATE=1` escape hatch). **Verified live:**
   a contender against the same PG stayed follower; killing the leader
   promoted it in 24s; the restarted backend stayed follower while the
   contender held the lock and re-acquired within 30s of its removal.
   Deviations from the 2026-07-15 sketch, on the merits: the **model
   warmer is NOT leader-gated** (it pins the LOCAL ollama — each instance
   must warm its own muscle); **compaction** is turn-inline, not a
   background singleton; **ingest_worker** needs no gate (claims use FOR
   UPDATE SKIP LOCKED) — but its startup orphan-requeue assumes a single
   instance (would requeue another instance's in-flight job); revisit at
   phase 2.
2. **Memory watcher + atomic appends.** Verify: append a memory file via
   a second writer, see it in search results without restart; repeat on
   an SMB mount for the poll fallback.
3. **Profile + docs**: `local-db` profile, a `docs/multi-instance.md`
   setup guide (env template for secondaries), Settings → Storage card
   shows which DB/memory home this instance uses (card exists — extend
   it with "shared/leader" status so the operator can SEE the topology).
   NOTE (2026-07-22): the `instance_id` identity + this topology surface
   are **co-owned with `observability-board.md`** (ROADMAP #30) — its
   health/topology strip is the same view, and its `is_leader()` gating
   depends on the leader work in phase 1 here. Define identity/leader once;
   don't build two topology cards.
4. Defer until real usage demands: per-file locking, conflict UI, live
   settings-change propagation (<20 s poll parity like soul-sync).

## Traps

- Do NOT ship any of this half-on: a secondary pointed at central PG but
  local memory dir is a split-brain entity. Startup should refuse
  (loudly) if `DATABASE_URL` is remote but `NOVA_MEMORY_DIR` is the
  default local path, unless an explicit
  `NOVA_ALLOW_SPLIT_STATE=1` escape hatch is set.
- Advisory lock ids are global per-DB: derive from a constant, document
  it, never reuse for another lock.
- `docker compose up -d backend` after env changes (CLAUDE.md trap).
