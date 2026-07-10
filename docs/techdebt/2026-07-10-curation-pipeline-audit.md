# Curation pipeline audit — 2026-07-10

**Objective (not reached):** one successful "Nightly memory curation" run producing
linked topic files, so the Brain graph gains its first edges. Twelve manual fires
peeled a different infrastructure failure each time; everything code-level is fixed
and merged, but the run never completed because **no capable model is available**.
The brain overhaul itself (#32/#34/#36) shipped and is visually verified — it does
not depend on this; the graph fills in whenever curation first succeeds.

## Fixed & merged today

| Fix | Where |
|---|---|
| Curation contract: titled topics, `## Sources` links to journals, cross-links, soul link | migration 120 (#34) |
| Contract addendum: NEVER write scripts — `remember()` calls are the mechanism (a capable model wrote `curate_memory.py` against invented APIs and self-reported success) | migration 121 (#37) |
| Journal noise gate: near-identical digests (modulo numbers) dropped pre-journal | memory-service (#34) |
| `think_json` salvages valid JSON wrapped in prose ("Extra data") + fixes retry fall-through | #37 |
| One tool call per agent round (local templates can't render parallel calls) — `AGENT_SINGLE_TOOL_CALL`, default true | #39 |

## Runtime state changed on THIS box (not in git)

- `pod_agents` (Quartet): `timeout_seconds` raised to 300/600/240 (guardrail 120) — defaults are cloud-tuned and the reaper kills local-model sessions mid-generation. **Repo defaults should become backend-aware.**
- `pod_agents.model` pinned to `openbmb/minicpm5:latest` (was NULL → inherits the contested default).
- `openbmb/minicpm5:latest` pulled into the bundled Ollama (it booted empty).
- Curation goal: maturation escalation cleared twice; will be `review` again after the last failure (correct behavior — see stuck detector below).

## The actual blocker: no model seat

Empirical provider audit through the gateway (`/complete` probes):

| Provider | State |
|---|---|
| groq | key rejected (401) |
| anthropic | credential rejection → rerouted local |
| openai | credential rejection → rerouted local |
| openrouter | 401 "User not found" |
| cerebras | authenticates; no access to any current model. `llm.cloud_fallback_model=cerebras/llama3.1-8b` points at a **retired** model |
| chatgpt subscription | all_providers_failed |
| gemini | **works** — free tier: 5 req/min, **20 req/day** (one task stage burns most of a day) |
| local minicpm5 | works for JSON-verdict stages (with salvage + long timeouts); tool stage OK only with #39; struggles under load-10 |

**Unblock = refresh one key** (groq is free: console.groq.com → Settings → AI & Models → Provider Status), then:

```sql
-- optional: point the pipeline at the refreshed provider
UPDATE pod_agents SET model = 'groq/llama-3.3-70b-versatile'
WHERE pod_id = (SELECT id FROM pods WHERE name = 'Quartet');
-- clear the stuck escalation and fire
UPDATE goals SET maturation_status = NULL, schedule_next_at = NOW()
WHERE title = 'Nightly memory curation';
```

Watch: `~/.nova/workspace/memory/topics/` for new files; `GET :8002/api/v1/memory/graph` for `edges > 0`.

## Open bugs found (autonomy lane)

1. **Gateway fallback forwards raw local model names to cloud providers** instead of substituting `llm.cloud_fallback_model` → local-first with a missing local model has no working fallback at all (total, silent outage).
2. **State-machine CAS race**: pipeline executes while every status write is rejected (`submitted → context_running` refused); task rows zombify as `submitted`, then get mis-reaped. Also `failed → failed` rejection noise.
3. **Consumed-but-skipped fires are invisible**: cortex acks a `goal.schedule_due` fire, then serve-drive filters (open-task dedupe, maturation `review`, cost cap) silently drop it. Log the skip reason; surface on the goal.
4. **Stuck-detector escalation is silent**: goal → maturation `review` disables its cron until a human visits /goals; nobody is told (should notify + show on the goal card).
5. **Gateway returns 200 + empty content on some provider failures** (cerebras model-not-found path) instead of an error — callers see "" and can't tell why.
6. Gateway doesn't honor 429 `retry_delay` hints (gemini's 6s) — one burst kills a parallel review group.
7. `llm.default_chat_model` was runtime-set to `openrouter/tencent/hy3:free` (dead key) during provider-status work — **chat/cortex/briefings fail through the dead chain while it stays**. Reset when that experiment concludes.
8. Cortex thinking loop generates ~3k tokens/cycle every ~80s on the local model — permanent background load worth revisiting.

## Timeline of the twelve attempts (for the curious)

502 empty-Ollama → JSON "Extra data" → 60s reaper kill → minicpm parallel-tool template 400 → gemini worked but agent wrote a script instead of calling remember() (parked for review) → dispatch silently blocked by parked task → blocked by maturation `review` → gemini 5/min then 20/day quota → maturation re-poisoned → default model hijacked to dead openrouter mid-flight → pinned-local attempt failed at context under load-10. Each arrow is a distinct root cause; all but the last two are fixed above.
