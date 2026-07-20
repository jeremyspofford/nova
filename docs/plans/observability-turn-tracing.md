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

### Data model (landed as migration 028)

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
(redacted), result_size, ok/error; `stage`: pipeline stage names —
**correction (2026-07-17 build)**: the "#55 wall-clock-kill stage hooks"
this plan wanted to reuse were old-repo work and don't exist in v3 (the
v3 kill is a plain `asyncio.wait_for` in `scheduler.run_one`), so stage
spans were added fresh (`build_prompt` with `memory_retrieval` nested);
`dispatch`: sub-agent name + its own span subtree via
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
  compaction` (the schema also carries the automation NAME; `warmer` was
  dropped — the model warmer never calls `stream_chat`). **Correction
  (2026-07-17 build)**: the "autonomous-rails action_ledger" this plan
  said to keep separate was old-repo work — v3 has no action_ledger.
  Nothing to keep separate; this turn ledger IS the accounting substrate
  item #16 (cost caps) expects.

Writes are fire-and-forget tasks (never add latency or a failure mode to
the chat path; on DB error, log and drop the span).

### Redaction (settled policy)

**Correction (2026-07-17 build):** the "existing guardian scrubber" this
section assumed does not exist in v3 — `rules.py` is a pre-execution
pattern gate with no redaction helper anywhere. `trace.py` carries its
own: key-name masking (token/secret/password/api_key/authorization/
credential/private_key) plus value-shape patterns (Bearer headers,
sk-style keys, JWTs). Additionally:
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
   **SHIPPED 2026-07-17 (Fable session):** migration 028, `app/trace.py`
   (contextvar turn/span helpers, buffered single-flush writes, built-in
   redaction), spans in `run_agent` (build_prompt → memory_retrieval
   nested, llm_call per round, tool, dispatch) and the turn opened in
   `chat_stream`. `include_usage` plumbed through the LLM router — BOTH
   providers return exact token counts (verified live: OpenRouter glm-5.2
   and local Ollama). Bonus pulled forward from phase 2: the assistant
   message is stamped with `metadata.trace_id` at persist time, so the
   duration chip needs no timestamp heuristics. Live-verified through
   :5173 and :8000: weather turn traced as 5 spans totaling 7.47s
   (prompt build 0.33s / llm 3.13s + 2.92s / tool 1.09s, 9.7k prompt
   tokens), no-tool turn traced clean with zero tool spans and no
   detector flag. The past-tense completion-claim detector extension
   shipped in the same pass (14/14 test cases).
2. Duration chip + Turn Inspector drawer. Verify: click from a real chat
   turn through :5173; walk the click path.
   **SHIPPED 2026-07-17 (same Fable session):** `GET /api/v1/traces/{id}`,
   trace summaries joined onto assistant rows in the messages API, and
   `trace_id` added to the stream's meta event so live turns chip without
   a lookup. `TurnInspector.tsx` renders the span waterfall (indented
   dispatch subtrees, per-kind colored duration bars, token totals,
   expandable detail JSON, Escape/backdrop close); the chip under each
   assistant message reads like "7.5s · 1 tool" (red when the turn
   failed). Live-verified through :5173 by walking the click path
   headlessly: chip → inspector → expanded details, screenshots checked.
   NOTE: the phone path (:8080 web) serves a baked build — rebuild web to
   see the chip there.
3. Automations/source column + Recent-turns list + retention job +
   Settings card. Verify: trigger an automation, find its trace in the
   UI without SQL.
   **SHIPPED 2026-07-18 (same Fable session):** `scheduler.run_one`
   wraps each run in `trace.turn("automation", ...)` (a timeout lands as
   status=cancelled); compaction's direct LLM call gets its own
   `compaction` turn + llm_call span; `GET /api/v1/traces` lists recent
   turns across all sources; `trace.maybe_prune()` piggybacks the
   scheduler tick (self-limited to daily, `trace.retention_days` setting,
   default 14, Settings → Observability); the Observability section
   renders the retention setting plus the Recent turns card (source
   badges, durations, click-through to the same Turn Inspector).
   Live-verified end-to-end: a probe automation's run appeared in the
   Recent turns list and opened in the inspector (6.34s, 3,178 tokens in —
   the 4.28s build_prompt span exposed the cold platform-detection cache,
   the exact item-14 suspect); a planted 30-day-old trace was pruned by
   the retention job on the next tick. This also closes #25's (d): the
   per-run tool timeline now persists as automation trace spans.

## Failure detectors ride the ledger (added 2026-07-17)

The live narration detector (shipped 2026-07-14) only matches
future/present announcements ("I'll dispatch…", "is now live") — by
design, since past-tense recaps after real work are correct behavior.
Found live during #27 verification: glm-5.2 answered "Done — saved it
with no tags" **two seconds** after the request with zero tool calls and
nothing written, and no banner fired. Past-tense fabrication slips the
wording heuristic entirely.

The turn ledger turns this from a wording problem into a ground-truth
check, so extend the detector in phase 1 (**SHIPPED 2026-07-17** — new
completion-claim patterns in `narration.py`, matched per sentence with
past-time-marker exemptions so honest recaps stay unflagged; the
"Done — saved it with no tags" incident text now flags):

- A **completion claim** (past-tense "saved/created/done/deleted/updated"
  about an action) in a turn whose trace contains **zero tool spans** is
  fabrication regardless of tense — flag it with the same amber banner +
  journal entry as announcements.
- Turn duration corroborates: a claimed multi-step action inside a
  near-instant turn (< ~3s, no llm tool rounds) cannot have happened.
- Tense stays relevant only for turns WITH tool spans: a past-tense recap
  after real calls stays unmatched, exactly as today.

## Decisions needed from Jeremy (everything above proceeds without them)

1. **Token counts**: ~~the LLM gateway may not return usage for all
   providers — is chars-only acceptable at first?~~ RESOLVED 2026-07-17:
   `stream_options.include_usage` was already supported by the client and
   just never requested — both OpenRouter and Ollama return exact counts,
   verified live. Chars are captured alongside as a fallback.
2. **Cost estimates**: attach $ estimates to cloud llm_call spans using
   the curated-models pricing data? (Plan assumes later; column reserved
   in `detail`.)
3. **Inspector placement on phone**: drawer works on desktop; phone may
   want it deferred to the mobile-routes item. (Plan assumes defer.)
