# Observability — turn tracing

Implementation plan (authored 2026-07-15 with Fable). Origin: the
2026-07-14 narration bug was diagnosed by hand-querying the messages
table; "that should be a click." This plan turns the ROADMAP brainstorm
axes into a buildable design. Three decisions are flagged for Jeremy at
the bottom; everything else is settled here.

## What exists (verified in code)

- The SSE contract already emits structured activity:
  `{"activity": {"kind": "tool_start|tool_result|dispatch|narration",
  "name", "agent", "detail"}}` (`backend/app/router_chat.py` docstring,
  events produced in `backend/app/agents/runner.py`).
- Messages journal these into the conversation. That gives *what happened*
  but not *when/how long/how big*, and querying it means SQL by hand.

## Design: a turn ledger, not a tracing platform

One new table + one UI surface. No OpenTelemetry, no sampling — this is a
single-operator system (pre-release, no users); completeness beats
scalability, and clean breaking changes are allowed.

### Data model (next free migration number — check `backend/app/migrations/`, 021 at time of writing)

```sql
turn_traces (
  id            uuid pk,
  conversation_id uuid,        -- join to messages
  started_at / finished_at timestamptz,
  status        text,          -- ok | error | cancelled
  model         text,          -- effective model for the main call
  error         text null
)
turn_spans (
  id            uuid pk,
  trace_id      uuid fk -> turn_traces on delete cascade,
  seq           int,           -- display order
  kind          text,          -- stage | llm_call | tool | dispatch
  name          text,          -- e.g. "context", "memory", tool name, agent name
  started_at / finished_at timestamptz,
  detail        jsonb          -- kind-specific, see redaction
)
```

`detail` per kind — `llm_call`: model, prompt_chars, completion_chars,
token counts if the gateway reports them, finish_reason; `tool`: args
(redacted), result_size, ok/error; `stage`: the existing pipeline stage
names (the wall-clock-kill work from #55 already knows stage boundaries —
reuse those hooks); `dispatch`: sub-agent name + its own span subtree via
`seq` nesting (add `parent_span_id uuid null` — flat is a lie once
sub-agents exist; include it from day one).

### Instrumentation

A tiny `trace.py` context helper in `backend/app/`: `async with
trace.span(kind, name, detail=...)`. Wrap in `run_agent`:
- one trace per chat turn, created in `chat_stream` right where the SSE
  `meta` event is emitted (it already knows conversation + model);
- spans around: history windowing, memory retrieval, each LLM call, each
  tool execution (the `yield {"type": "activity"...}` sites in
  `runner.py` are exactly the right seams — instrument there so SSE and
  ledger can never disagree);
- automations/scheduled runs get traces too (same helper, no conversation)
  — `conversation_id null`, plus a `source` column: `chat | automation |
  compaction | warmer`. The autonomous-rails ledger (action_ledger) stays
  separate — it answers "what did she DO in the world", this answers
  "what did a turn COST and where did the time go"; link by timestamp
  range, don't merge them.

Writes are fire-and-forget tasks (never add latency or a failure mode to
the chat path; on DB error, log and drop the span).

### Redaction (settled policy, matches guardian rules)

Tool args pass through the existing no-secret patterns before storage:
apply the same scrubber the guardian uses for requests. Additionally:
`detail` args truncate at 2 KB per span, results store size + first 500
chars only. Full prompt/completion TEXT is NOT stored (chars/tokens
counts only) — the conversation already holds what the user saw, and
storing full prompts doubles every turn's footprint and its secret
surface. If a debugging session needs full prompts, that's a temporary
`NOVA_TRACE_VERBOSE=1` env toggle (documented as dev-only, off by
default), not a stored default.

### Retention

Nightly job (piggyback the existing scheduler): delete traces older than
`trace.retention_days` (settings_store key, default 14). Traces are
diagnostics, not memory — nothing else may depend on them.

### UI — reachable by navigation, not search (memory rule)

1. **Per-message entry point**: a subtle duration chip on each assistant
   message in `ChatPanel.tsx` ("3.8s · 2 tools"); click → Turn Inspector.
2. **Turn Inspector**: right-side drawer (same pattern as existing
   drawers): waterfall of spans (name, kind icon, duration bar, expand for
   detail JSON). No new routes needed on desktop.
3. **Settings → Observability card**: retention setting + link to a plain
   "Recent turns" list (last 50 traces incl. automations — the ones with
   no chat message to click).

### Phases

1. Migration + `trace.py` + instrument `run_agent` + `chat_stream`.
   Verify: chat a turn that uses a tool, query the two tables, spans
   nest and timings are sane.
2. Duration chip + Turn Inspector drawer. Verify: click from a real chat
   turn through :5173; walk the click path.
3. Automations/source column + Recent-turns list + retention job +
   Settings card. Verify: trigger an automation, find its trace in the
   UI without SQL.

## Decisions needed from Jeremy (everything above proceeds without them)

1. **Token counts**: the LLM gateway may not return usage for all
   providers — is chars-only acceptable at first? (Plan assumes yes.)
2. **Cost estimates**: attach $ estimates to cloud llm_call spans using
   the curated-models pricing data? (Plan assumes later; column reserved
   in `detail`.)
3. **Inspector placement on phone**: drawer works on desktop; phone may
   want it deferred to the mobile-routes item. (Plan assumes defer.)
