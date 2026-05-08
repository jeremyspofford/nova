# Kill-Switch Runbook

> **Naming context:** kill-switches are one of four flag namespaces — see
> [docs/runbooks/feature-flags.md](feature-flags.md) for the full taxonomy.

> Operational reference for Nova's `kill.*` feature flags. One section per
> flag. SRE acceptance criterion **SR5** from the prod-readiness memo.

## How to use this document

When a Nova subsystem is misbehaving in a way that needs to stop *now*
(burning an upstream, looping on poison data, starving other services),
flip the corresponding `kill.*` flag instead of restarting the container.
A restart drops in-flight state and may page dependent services as
"degraded"; a kill-switch flag pauses the misbehaving subsystem in
place.

**Every kill-switch flag follows the same operational contract:**

1. **Propagation latency:** typical ~5 ms (Redis pubsub); worst-case
   ≤ 60 s (cache TTL fallback if a service's pubsub link dropped). The
   formal CI test (`PUBSUB_PROPAGATION_TIMEOUT_S = 5`) asserts the happy
   path is well under 5 s.
2. **In-flight semantics:** the cycle/iteration that's already running
   when you flip the flag finishes to completion. Only the *next* cycle
   is suppressed. This is intentional — partial work produces orphan
   state.
3. **Rollback:** clear the flag (DELETE) or set it back to `false`.
   The next loop iteration resumes within one cycle. Each service logs
   on the resume edge ("kill.X cleared — resuming Y").

**How to flip a flag:**

```bash
# Settings → System → Feature Flags  (preferred — second-modal confirm)
# Or via API:
curl -X PATCH 'http://localhost:8000/api/v1/feature-flags/<key>' \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"value": true, "confirm": "<key>"}'   # `confirm` required for CRITICAL_FLAGS

# Verify in real time (see "Verification" per flag below):
docker logs nova-<service>-1 -f | grep -E '<key>|pausing|resuming'

# Roll back:
curl -X DELETE 'http://localhost:8000/api/v1/feature-flags/<key>' \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET"
```

**The audit table:** every PATCH/DELETE writes to `feature_flag_audit`
with `actor_ip`, `actor_user_agent`, and `request_id`. Use this to
reconstruct who flipped what during an incident review:

```sql
SELECT key, action, old_value, new_value, actor, actor_ip, occurred_at
FROM feature_flag_audit
WHERE key = '<key>'
ORDER BY occurred_at DESC
LIMIT 20;
```

---

## `kill.intel_worker.poll`

**Service:** `intel-worker` (port 8110)

**Critical flag:** No (the WORST case is "AI ecosystem feeds stop
arriving for a few minutes" — annoying but not user-impacting).

**Expected effect:** The intel-worker stops fetching RSS / Reddit /
GitHub-trending feeds. The `Polling loop started` cycle becomes a
no-op `asyncio.sleep(poll_interval)`. Feed-status rows in the DB
remain stable; `engram:ingestion:queue` stops gaining new intel-worker
items.

**When to flip:**

- An upstream RSS source is rate-limiting Nova's IP and you need to
  back off without rebuilding/restarting.
- A poison feed is returning malformed content that's filling the
  ingestion queue with errors.
- General "stop autonomous traffic to upstreams" lockdown drill.

**Verification:**

```bash
docker logs nova-intel-worker -f | grep -E 'kill\.intel_worker|pausing|resuming'
# Expect within ~5 s of PATCH:
#   flag_invalidation_received key_hint='kill.intel_worker.poll'
#   flag_value_changed key=kill.intel_worker.poll old=False new=True
# Within poll_interval (default 60 s), at the next cycle boundary:
#   kill.intel_worker.poll=True — pausing feed polling (no fetches until flag cleared)
```

If you don't see `pausing` within `poll_interval` seconds after the
flag flip, the polling loop may be stuck mid-cycle on a slow upstream
fetch. That's acceptable (in-flight semantics) but worth confirming
with `docker logs nova-intel-worker --tail 50` to see the active
fetch.

**Rollback:** DELETE the flag. The next loop iteration sees `False`,
logs `cleared — resuming feed polling`, and the next due feed fetches.

---

## `kill.knowledge_worker.crawl`

**Service:** `knowledge-worker` (port 8120, `--profile knowledge`)

**Critical flag:** No (autonomous knowledge crawling is opt-in).

**Expected effect:** The crawl scheduler stops dispatching new crawls.
In-flight crawls in the `_active_crawls` set finish to completion
(this is *especially important* for crawls that hold credentials —
killing mid-flight may leak secrets). New `is_due` sources are
deferred until the flag clears.

**When to flip:**

- A misconfigured crawl source is hammering an upstream (e.g.
  GitHub API rate limit exceeded).
- A user revokes a linked-account credential and you want crawls
  using it to stop *now* rather than at next scheduler iteration.
- Cost containment: LLM relevance scoring is part of the crawl
  pipeline; pausing it pauses LLM spend.

**Verification:**

```bash
docker logs nova-knowledge-worker -f | grep -E 'kill\.knowledge|pausing|resuming|_active_crawls'
# Expect within ~5 s:
#   flag_value_changed key=kill.knowledge_worker.crawl old=False new=True
# Within poll_interval (default 300 s):
#   kill.knowledge_worker.crawl=True — pausing scheduler
#     (in-flight crawls complete; new ones deferred)
```

**Rollback:** DELETE the flag. Scheduler resumes on next iteration;
sources whose `next_run_at` passed during the pause are picked up
immediately.

---

## `kill.engram.ingestion`

**Service:** `memory-service` (port 8002)

**Critical flag:** **Yes** — typed-confirm required. Flipping this
stops ALL new memory writes platform-wide. Chat exchanges, intel-feed
content, knowledge-crawl excerpts, screenpipe focus sessions — they
all queue but don't decompose into engrams until cleared.

**Expected effect:** The `BLMOVE` from `engram:ingestion:queue` to
the per-worker processing list still runs (atomic, can't partially
move), but the worker checks the kill flag at loop-top and re-queues
or sleeps without decomposing. **The queue continues to grow while
paused** — operator must monitor depth or the queue can OOM Redis.

```bash
docker compose exec redis redis-cli -n 0 LLEN engram:ingestion:queue
```

**When to flip:**

- The decomposition LLM is producing garbage (model outage, wrong
  model auto-resolved) and you don't want bad engrams persisted.
- A poison payload is causing decomposition to crash repeatedly,
  and you want to inspect the queue before retrying.
- Cost containment: decomposition is LLM-heavy.

**Verification:**

```bash
docker logs nova-memory-service-1 -f | grep -E 'kill\.engram\.ingestion|paused|resuming'
# Expect:
#   flag_value_changed key=kill.engram.ingestion old=False new=True
# Within ingestion_batch_timeout (default 1 s):
#   kill.engram.ingestion=True — new decomposition paused
#     (in-flight items still complete; queue continues to grow)
```

**Rollback:** DELETE the flag. Decomposition resumes; the queue
backlog drains at the configured concurrency (default
`Semaphore(5)` per the spec).

**Operational note:** When you intend to leave this on for >1 hour,
also pause upstream producers (intel-worker, knowledge-worker,
screenpipe-bridge) so the queue doesn't grow unboundedly.

---

## `kill.consolidation.cycle`

**Service:** `memory-service` (port 8002)

**Critical flag:** **Yes** — typed-confirm required. The
consolidation pipeline runs the 6-phase "sleep cycle" (replay,
pattern extraction, Hebbian learning, contradiction resolution,
pruning, self-model update) and is mutex-guarded — cancelling
mid-cycle isn't safe.

**Expected effect:** The scheduler that triggers consolidation
on idle/threshold/nightly stops firing. Any consolidation cycle
already in progress completes (mutex-guarded). New cycles are
suppressed until the flag clears.

**When to flip:**

- The consolidation LLM is producing bad pattern extractions
  (model outage / wrong auto-resolved model) and you want to
  freeze the engram graph in its current state.
- LLM quota is tight and you need to preserve budget for
  user-facing pipeline work.
- Investigating a consolidation-induced regression: pause to
  inspect the graph at a known-good point in time.

**Verification:**

```bash
docker logs nova-memory-service-1 -f | grep -E 'kill\.consolidation|cycle scheduler|pausing|resuming'
# Expect within 60 s (the scheduler's check interval):
#   kill.consolidation.cycle=True — pausing cycle scheduler
#     (no triggers will fire until flag cleared)
```

**Rollback:** DELETE the flag. Scheduler resumes on next 60-s tick;
if the idle threshold was exceeded during the pause, a cycle fires
immediately.

---

## `kill.cortex.thinking_loop`

**Service:** `cortex` (port 8100)

**Critical flag:** **Yes** — typed-confirm required. The cortex
thinking loop is the autonomous brain — flipping this stops Nova
from initiating any work on its own. The chat / pipeline endpoints
still work; the brain just doesn't take its own initiative.

**Expected effect:** The `_loop` in `cortex/app/loop.py` checks the
flag at top-of-cycle. Wrapped *outside* the runtime
`features.brain_enabled` config check, so this kill switch shuts
down the brain even if it's failing the enabled gate (e.g. a bug
that loops on the enabled-state check itself).

**When to flip:**

- Cortex is firing cycles too frequently (`cycle_interval_seconds`
  misconfigured) and you want to stop the LLM cost.
- A drive (maintain, learn, quality, etc.) is misbehaving and
  spamming task creation.
- Drill: simulate "Nova is offline as an autonomous agent" without
  taking down chat.

**Verification:**

```bash
docker logs nova-cortex-1 -f | grep -E 'kill\.cortex|thinking loop|pausing|resuming'
# Expect:
#   flag_value_changed key=kill.cortex.thinking_loop old=False new=True
# Within cycle_interval_seconds (default 60 s):
#   kill.cortex.thinking_loop=True — pausing thinking loop
```

**Rollback:** DELETE the flag. Thinking loop resumes on next iteration.
The Redis `cortex.brpop` stimulus list buffers events during the pause;
they fire in order on resume.

---

## When the kill switch *itself* is broken

If a flag flip doesn't propagate within the 60 s TTL bound:

1. **Check the orchestrator's audit table** to confirm the PATCH
   committed:
   ```sql
   SELECT * FROM feature_flag_audit ORDER BY occurred_at DESC LIMIT 5;
   ```
2. **Check the consuming service's `flag_pubsub_connected` health:**
   ```bash
   curl -s http://localhost:<service-port>/health/ready | jq '.'
   ```
   If `flag_pubsub_connected: false`, the service has lost its Redis
   subscriber and is serving stale cached values.
3. **Last-resort restart** of the consuming service container:
   ```bash
   docker restart nova-<service>-1
   ```
   The service's startup `warm_cache_from_http` rereads the
   authoritative state from orchestrator. The cache file at
   `data/flag-cache/<service>.json` is also rehydrated, so even if
   orchestrator is unreachable at restart, the last-seen kill state
   applies (SR3 fail-closed semantics).
4. **Boot-time env-var override** (last resort, for cold-boot
   lockdown only): set `NOVA_FLAG_<KEY>=true` in the service's
   environment before startup. *Note:* env-var changes require
   container restart; this is **not** a hot-path tool. Use it when
   you need to ensure a service comes up with a flag pre-set, e.g.
   to recover a service that was crashing on hot-path code that the
   flag gates.

## Audit-bypass paths to be aware of

- **Env-var override (`NOVA_FLAG_<KEY>`)** bypasses the audit table.
  Each service emits a structured `WARN` log (`flag_envvar_override_used`)
  on every read so log aggregation can alert. Search:
  ```bash
  docker logs nova-<service>-1 2>&1 | grep flag_envvar_override_used
  ```
- **Direct DB writes** to `feature_flags` bypass the router's audit
  trail. Don't do this in production; if you must (e.g. recovery
  from an admin-API outage), insert a manual `feature_flag_audit`
  row alongside the change.
