# Proactivity — Design (continuity-memory increment 2)

**Date:** 2026-06-10
**Status:** Approved for implementation (autonomous session; review surface = PR)
**Author:** Claude (directed by Jeremy)

## Why

Increment 2 of the continuity-memory plan (`2026-06-09-continuity-memory-design.md`):

> a lightweight autonomy pulse inside agent-core (not a new service): periodic
> self-review schedule (`created_by='nova'`), an LLM "anything worth doing?" gate with
> a hard budget cap and kill switch, plus a Nova-initiated message surface in the
> dashboard (proactive inbox). Builds directly on the scheduler.

Reactive (chat) and scheduled (cron) autonomy exist; *self-initiated* does not. The
scheduler was verified end-to-end and schedule output now lands in per-schedule chat
threads (PR #21) — the pulse rides both.

Per the recommended-models spec (`2026-06-10-recommended-models-design.md`), the
**model tool-call verification gate** lands here as the safety prerequisite:
proactive cycles must not run on a model that can't tool-call.

## Design

### The pulse is a schedule, not a service

Migration 014 seeds one row in `schedules`:

- `name='nova-self-review'`, `created_by='nova'`, enabled, trigger
  `{"type": "interval", "every_seconds": 14400}` (4 h default — edit in the Schedules
  page like any schedule).
- The prompt is the "anything worth doing?" gate itself: review recent context via
  existing tools (`memory.search`, schedules, recent task outcomes), then either do
  one small concrete useful thing and summarize it in 1–3 sentences, **or reply with
  exactly `NOTHING`**.

No new loop, no new service: firing, concurrency guarding, output surfacing, and the
chat thread (`⏰ nova-self-review` in the sidebar) are all the verified scheduler
machinery. The thread is the v1 proactive inbox — Nova-initiated messages appear in
chat, reply-able like any conversation. A dedicated inbox UI (unread badges) is
deferred until dashboard work can be Playwright-verified per the regression gate.

### Quiet runs stay quiet

`post_schedule_result` gains one convention: a **completed** run whose result is
exactly `NOTHING` is not posted to the thread (and logged at DEBUG). Otherwise a 4-h
pulse with nothing to say spams six messages a day. Documented for all schedules, not
just the pulse. Failure notes always post.

### Guards on autonomous dispatch (scheduler, `created_by='nova'` rows only)

Checked at dispatch time in the poll loop, in order; any failure skips the fire
(next_fire still advances — no pile-up):

1. **Kill switch** — `app_config` key `proactivity.enabled` (default `true`; the
   schedule's own `enabled` toggle is a second, independent off-switch).
2. **Hard budget** — at most `proactivity.daily_task_budget` (default `12`)
   nova-schedule dispatches per rolling 24 h, counted from `tasks` rows joined to
   nova-created schedules. The agent loop's existing `MAX_ITERATIONS=20` bounds each
   run's size.
3. **Tool-capability gate** — the active completion model must support tool calling,
   verified through llm-gateway (below). Unknown (non-Ollama backends, cloud) ⇒
   allowed; known-false ⇒ blocked.

When a guard newly trips (state change, tracked in `app_config` key
`proactivity.last_block_reason`), one explanatory note posts to the pulse's thread —
silent-failure was the original sin of this roadmap item. Repeat skips for the same
reason only log.

User-created schedules are untouched by all guards: the user asked for those fires.

### Tool-capability verification (llm-gateway)

`GET /models/capabilities?model=X[&probe=true]`:

- **Ollama backends** (`ollama`, `ollama-host`): `POST {url}/api/show {"model": X}` →
  `capabilities` array (verified live: qwen2.5 reports `['completion','tools']`,
  nomic-embed-text `['embedding']`). `tools: true/false`.
- **Other local backends** (vllm/llamacpp/sglang/lmstudio): no capability API —
  `tools: null` (unknown).
- **Cloud model ids** (provider-prefixed or known cloud names): `tools: true`.
- **`probe=true`**: one `/complete` round-trip with a trivial tool at
  `temperature 0`; `probe_passed` reflects whether a well-formed tool call came back.
  Ground truth for the Models page later; the scheduler guard uses the cheap
  `/api/show` path only.
- Results cached 10 min (same TTL discipline as discovery). Errors ⇒ `tools: null`
  (unknown ⇒ allowed) — fault-tolerant per convention; the gate blocks only on a
  definitive "no tools".

agent-core proxies it at `GET /api/v1/llm/models/capabilities` (memories-proxy
pattern) for the dashboard and the scheduler guard.

### Control API (agent-core)

`GET /api/v1/proactivity` → `{enabled, daily_task_budget, dispatches_today,
last_block_reason, schedule_id}`; `PUT /api/v1/proactivity` accepts
`{enabled?, daily_task_budget?}`. Admin-auth. Gives the dashboard a toggle without
psql.

## Out of scope (this increment)

Dedicated inbox UI with unread state (needs Playwright-verifiable dashboard work),
notification channels (increment 6), the full recommended-models manifest/UI (next
increment), per-goal budgets (Phase-7-era), blocking model *selection* on probe
results (models increment).

## Testing (real services, no mocks)

- **Unit** (`agent-core/tests/`): guard matrix (kill switch off / budget exhausted /
  tools-false ⇒ skip; tools-null/true + budget ok ⇒ dispatch), NOTHING suppression,
  block-reason transition posts once.
- **Integration** (`tests/test_proactivity.py`, added to `make test-v2`): capabilities
  endpoint against real Ollama (tools model ⇒ true, embed model ⇒ false); seeded
  pulse schedule exists with `created_by='nova'`; control API round-trip; kill switch
  off ⇒ pulse fire skipped (fire_count unchanged) while a user schedule still fires;
  budget=0 ⇒ skipped; restored ⇒ dispatches and (non-NOTHING) output lands in the
  thread.
- Verified in-session against the native stack (Postgres 16 + agent-core +
  llm-gateway + Ollama qwen2.5).
